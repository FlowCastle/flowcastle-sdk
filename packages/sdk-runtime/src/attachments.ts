import type { JsonObject, JsonValue } from './types';

/** JSON-safe binary attachment transported inside a runtime job. */
export interface FlowCastleFileMarker {
  $flowcastleFile: { filename: string; base64: string; contentType?: string };
}

export interface DecodedFile {
  filename: string;
  bytes: Uint8Array;
  contentType?: string;
}

export type TransportParamDecoder<TFile> = (file: DecodedFile) => TFile;
export type DecodedTransportValue<TFile> = JsonValue | TFile | DecodedTransportObject<TFile> | DecodedTransportValue<TFile>[];
export interface DecodedTransportObject<TFile> { readonly [key: string]: DecodedTransportValue<TFile>; }

function isFileMarker(value: JsonValue): value is JsonObject & FlowCastleFileMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('$flowcastleFile' in value)) return false;
  const marker = value.$flowcastleFile;
  return typeof marker === 'object' && marker !== null && !Array.isArray(marker) && typeof marker.filename === 'string' && typeof marker.base64 === 'string';
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error('FlowCastle: invalid base64 file marker');
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/** Recursively replaces file markers; each language adapter supplies its native file value. */
export function decodeTransportParams<TFile>(value: JsonValue, decodeFile: TransportParamDecoder<TFile>): DecodedTransportValue<TFile> {
  if (isFileMarker(value)) {
    const marker = value.$flowcastleFile;
    return decodeFile({ filename: marker.filename, bytes: decodeBase64(marker.base64), ...(typeof marker.contentType === 'string' ? { contentType: marker.contentType } : {}) });
  }
  if (Array.isArray(value)) return value.map((entry) => decodeTransportParams(entry, decodeFile));
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, DecodedTransportValue<TFile>> = {};
    for (const [key, entry] of Object.entries(value)) output[key] = decodeTransportParams(entry, decodeFile);
    return output;
  }
  return value;
}
