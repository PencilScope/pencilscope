import type { ApiEnvironment } from "./index";

function configuredInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export type PriceBreakdown = {
  creatorPriceCents: number;
  platformFixedFeeCents: number;
  serviceFeeBps: number;
  serviceFeeCents: number;
  plannedMeetingMinutes: number;
  plannedMeetingParticipants: number;
  plannedPaidLearners: number;
  plannedMeetingCostCents: number;
  meetingAllocationCents: number;
  checkoutPriceCents: number;
};

export function calculateOfferingPrice(
  env: ApiEnvironment,
  creatorPriceCents: number,
  plannedMeetingMinutes = 0,
  plannedMeetingParticipants = 0,
  plannedPaidLearners = 1
): PriceBreakdown {
  const minimumCreatorPrice = configuredInteger(env.MIN_COURSE_PRICE_CENTS, 50, 1, 1_000_000);
  if (!Number.isSafeInteger(creatorPriceCents) || creatorPriceCents < minimumCreatorPrice || creatorPriceCents > 1_000_000) {
    throw new Error(`Creator tuition must be at least ${(minimumCreatorPrice / 100).toFixed(2)}.`);
  }
  if (!Number.isSafeInteger(plannedMeetingMinutes) || plannedMeetingMinutes < 0 || plannedMeetingMinutes > 100_000) {
    throw new Error("Planned meeting minutes are invalid.");
  }
  if (!Number.isSafeInteger(plannedMeetingParticipants) || plannedMeetingParticipants < 0 || plannedMeetingParticipants > 10_000) {
    throw new Error("Planned meeting participants are invalid.");
  }
  if (!Number.isSafeInteger(plannedPaidLearners) || plannedPaidLearners < 1 || plannedPaidLearners > 10_000) {
    throw new Error("Planned paid learners must be at least one.");
  }
  const platformFixedFeeCents = configuredInteger(env.PLATFORM_FIXED_FEE_CENTS, 50, 0, 100_000);
  const serviceFeeBps = configuredInteger(env.PLATFORM_FEE_BPS, 1000, 0, 10_000);
  const meetingRateMicros = configuredInteger(env.PLATFORM_MEETING_RATE_MICROS, 4000, 0, 1_000_000);
  const serviceFeeCents = Math.ceil(creatorPriceCents * serviceFeeBps / 10_000);
  const participantMinutes = plannedMeetingMinutes * plannedMeetingParticipants;
  const plannedMeetingCostCents = Math.ceil(participantMinutes * meetingRateMicros / 10_000);
  const meetingAllocationCents = Math.ceil(plannedMeetingCostCents / plannedPaidLearners);
  return {
    creatorPriceCents,
    platformFixedFeeCents,
    serviceFeeBps,
    serviceFeeCents,
    plannedMeetingMinutes,
    plannedMeetingParticipants,
    plannedPaidLearners,
    plannedMeetingCostCents,
    meetingAllocationCents,
    checkoutPriceCents: creatorPriceCents + platformFixedFeeCents + serviceFeeCents + meetingAllocationCents
  };
}
