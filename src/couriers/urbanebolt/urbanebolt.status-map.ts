import type { ShipmentStatus } from '../shipment.types';

/** MAN and CAN are confirmed in UAT; the rest follow UrbaneBolt's documented vocabulary. */
export const URBANEBOLT_STATUS_MAP: Readonly<Record<string, ShipmentStatus>> = {
  MAN: 'CREATED',
  CAN: 'CANCELLED',
  PKP: 'PICKED_UP',
  PUP: 'PICKED_UP',
  INT: 'IN_TRANSIT',
  BAG: 'IN_TRANSIT',
  ARR: 'IN_TRANSIT',
  DEP: 'IN_TRANSIT',
  OFD: 'OUT_FOR_DELIVERY',
  DEL: 'DELIVERED',
  POD: 'DELIVERED',
  RTO: 'RTO',
  RTD: 'RTO',
  NDR: 'IN_TRANSIT', // failed delivery attempt; still moving
  LOS: 'FAILED',
  DMG: 'FAILED',
};

/** Null for an unknown code — guessing could mark a lost parcel as healthy. */
export function toShipmentStatus(code: string | null | undefined): ShipmentStatus | null {
  if (!code) return null;
  return URBANEBOLT_STATUS_MAP[code.trim().toUpperCase()] ?? null;
}
