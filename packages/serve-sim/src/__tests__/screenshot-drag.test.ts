import { describe, expect, test } from "bun:test";
import {
  DOWNLOAD_URL_TYPE,
  setBrowserScreenshotDragData,
} from "../client/utils/screenshot-drag";

describe("setBrowserScreenshotDragData", () => {
  test("offers a desktop download and a File for in-browser drop targets", () => {
    const values = new Map<string, string>();
    const files: File[] = [];
    const dataTransfer = {
      setData(type: string, value: string) {
        values.set(type, value);
      },
      items: {
        add(file: File) {
          files.push(file);
          return null;
        },
      },
    };
    const file = new File(["png"], "serve-sim-screenshot.png", {
      type: "image/png",
    });

    setBrowserScreenshotDragData(dataTransfer, {
      file,
      url: "blob:https://preview.example/shot",
    });

    expect(values.get(DOWNLOAD_URL_TYPE)).toBe(
      "image/png:serve-sim-screenshot.png:blob:https://preview.example/shot",
    );
    expect(files).toEqual([file]);
  });

  test("sanitizes delimiters and line breaks in the desktop filename", () => {
    const values = new Map<string, string>();
    const dataTransfer = {
      setData(type: string, value: string) {
        values.set(type, value);
      },
      items: { add: () => null },
    };
    const file = new File(["png"], "shot:one\n.png", { type: "image/png" });

    setBrowserScreenshotDragData(dataTransfer, {
      file,
      url: "blob:https://preview.example/shot",
    });

    expect(values.get(DOWNLOAD_URL_TYPE)).toBe(
      "image/png:shot-one-.png:blob:https://preview.example/shot",
    );
  });
});
