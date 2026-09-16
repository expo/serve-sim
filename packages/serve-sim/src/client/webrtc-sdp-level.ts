/// Level 5.2. Allows 36864 macroblocks per frame, past any simulator surface.
export const H264_SEND_LEVEL_IDC = 0x34;

/// Level 1b is level_idc 11 plus constraint_set3_flag, so the flag has to go when raising.
/// For High profiles the same bit means Intra, which must be left alone.
const LEVEL_IDC_1B = 0x0b;
const CONSTRAINT_SET3_FLAG = 0x10;
const LEVEL_1B_PROFILE_IDCS = new Set([0x42, 0x4d, 0x58]);

/// Exactly 6 hex digits; a longer run is malformed and must not be half-rewritten.
const PROFILE_LEVEL_ID = /(profile-level-id=)([0-9a-fA-F]{6})(?![0-9a-fA-F])/g;

/// Raise the level in every H.264 `profile-level-id` of an offer.
///
/// Browsers advertise Level 3.1 whatever they can decode, and libwebrtc builds its encoder
/// from the level in this offer: past that level's frame size it encodes nothing at all.
/// This is SDP munging, not negotiation — see `docs/webrtc-architecture.md`.
export function raiseH264OfferLevel(sdp: string, levelIdc: number = H264_SEND_LEVEL_IDC): string {
  if (!Number.isInteger(levelIdc) || levelIdc <= 0 || levelIdc > 0xff) return sdp;
  const raised = levelIdc.toString(16).padStart(2, "0");
  return sdp.replace(PROFILE_LEVEL_ID, (match, prefix: string, value: string) => {
    const profileIdc = Number.parseInt(value.slice(0, 2), 16);
    const profileIop = Number.parseInt(value.slice(2, 4), 16);
    const current = Number.parseInt(value.slice(4, 6), 16);
    if (current >= levelIdc) return match;
    const wasLevel1B = current === LEVEL_IDC_1B && LEVEL_1B_PROFILE_IDCS.has(profileIdc);
    const iop = wasLevel1B ? profileIop & ~CONSTRAINT_SET3_FLAG : profileIop;
    return `${prefix}${value.slice(0, 2)}${iop.toString(16).padStart(2, "0")}${raised}`;
  });
}
