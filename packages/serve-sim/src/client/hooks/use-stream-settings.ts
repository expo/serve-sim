import { useCallback, useEffect, useRef, useState } from "react";
import {
  mergeStreamControlSettings,
  normalizeStreamEncoderSettings,
  streamControlSettingsFrom,
  streamEncoderSettingsFrom,
  type StreamControlSettings,
  type StreamEncoderSettings,
  type StreamPlaybackSettings,
  type StreamSettings,
} from "../../stream-settings";

const HTTP_CODEC_STORAGE_KEY = "serve-sim:codec";

function playbackSettingsFrom(settings: StreamControlSettings): StreamPlaybackSettings {
  return {
    transport: settings.transport,
    httpCodec: settings.httpCodec,
    webRtcCodec: settings.webRtcCodec,
    ...(settings.iceServers ? { iceServers: settings.iceServers } : {}),
  };
}

function initialControlSettings(initialSettings: StreamSettings | undefined): StreamControlSettings {
  const settings = streamControlSettingsFrom(initialSettings);
  if (settings.transport !== "http" || settings.httpCodec !== "auto") return settings;
  try {
    const stored = window.localStorage.getItem(HTTP_CODEC_STORAGE_KEY);
    if (stored === "auto" || stored === "mjpeg" || stored === "h264") {
      return mergeStreamControlSettings(settings, { httpCodec: stored });
    }
  } catch {
    // Storage can be unavailable in an embedded or privacy-restricted viewer.
  }
  return settings;
}

/** Keep playback choices per viewer while synchronizing shared native encoder controls. */
export function useStreamSettings({
  device,
  endpoint,
  initialSettings,
}: {
  device: string;
  endpoint?: string;
  initialSettings?: StreamSettings;
}) {
  const [settings, setSettings] = useState<StreamControlSettings>(() =>
    initialControlSettings(initialSettings)
  );
  const [pending, setPending] = useState(false);
  const settingsRef = useRef(settings);
  const pendingRef = useRef(false);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    const version = ++requestVersionRef.current;
    const initial = initialControlSettings(initialSettings);
    const controller = new AbortController();
    settingsRef.current = initial;
    pendingRef.current = false;
    setSettings(initial);
    setPending(false);
    if (!endpoint) return () => controller.abort();

    void fetch(endpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Stream settings request failed (${response.status})`);
        const loaded = normalizeStreamEncoderSettings(
          await response.json() as Partial<StreamEncoderSettings>,
          streamEncoderSettingsFrom(initial),
        );
        if (!controller.signal.aborted && requestVersionRef.current === version) {
          const next = mergeStreamControlSettings(settingsRef.current, loaded);
          settingsRef.current = next;
          setSettings(next);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.warn("Failed to load stream settings", error);
      });
    return () => controller.abort();
  }, [device, endpoint, initialSettings]);

  const updatePlayback = useCallback((patch: Partial<StreamPlaybackSettings>) => {
    if (patch.httpCodec !== undefined) {
      try {
        window.localStorage.setItem(HTTP_CODEC_STORAGE_KEY, patch.httpCodec);
      } catch {
        // Keep the in-memory preference when storage is unavailable.
      }
    }
    const next = mergeStreamControlSettings(settingsRef.current, patch);
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const updateEncoder = useCallback((patch: Partial<StreamEncoderSettings>) => {
    if (!endpoint || pendingRef.current || Object.keys(patch).length === 0) return;
    const previous = settingsRef.current;
    const optimistic = mergeStreamControlSettings(previous, patch);
    settingsRef.current = optimistic;
    setSettings(optimistic);
    const version = ++requestVersionRef.current;
    pendingRef.current = true;
    setPending(true);

    void fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Stream settings update failed (${response.status})`);
      const updated = normalizeStreamEncoderSettings(
        await response.json() as Partial<StreamEncoderSettings>,
        streamEncoderSettingsFrom(optimistic),
      );
      if (requestVersionRef.current === version) {
        const next = mergeStreamControlSettings(settingsRef.current, updated);
        settingsRef.current = next;
        setSettings(next);
      }
    }).catch((error) => {
      console.warn("Failed to update stream settings", error);
      if (requestVersionRef.current === version) {
        const restored = mergeStreamControlSettings(previous, playbackSettingsFrom(settingsRef.current));
        settingsRef.current = restored;
        setSettings(restored);
      }
    }).finally(() => {
      if (requestVersionRef.current === version) {
        pendingRef.current = false;
        setPending(false);
      }
    });
  }, [endpoint]);

  return {
    settings,
    updatePlayback,
    updateEncoder,
    pending,
    encoderSettingsAvailable: !!endpoint,
  };
}
