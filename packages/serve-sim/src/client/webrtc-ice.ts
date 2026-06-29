export type IceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type IceTransportPolicy = "all" | "relay";

export function webRtcIceTransportPolicy(_servers: IceServer[]): IceTransportPolicy {
  return "all";
}
