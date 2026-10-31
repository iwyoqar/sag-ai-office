// The district layout lives in @sag/shared (packages/shared/src/district.ts), so the server validates map placements
// with exactly the same geometry the 3D world draws. Re-exported here for the scene code and its tests.
export {
  DISTRICT_CONFIG, planDistrict, placementFor, rowPitch, slotAt, slotPitchX, slotRect, slotStatus, streetZ,
  type DistrictConfig, type DistrictPlan, type PlannedBlock, type PlannedStore, type SlotStatus, type StreetLine,
} from "@sag/shared";
