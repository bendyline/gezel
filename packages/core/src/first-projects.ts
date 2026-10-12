/**
 * The first projects the meester's welcome offers.
 *
 * Each is a goal a project type carries end to end with one lead and its own
 * tools, finishing on a board the person can open: on a 12B on-device model a
 * family trip went from the ask to a ten-day itinerary on the trip board in
 * well under a minute. The longer gilde writing books (a menu plan, thank-you
 * notes) are four- and five-role runs with no evidence yet that they finish on
 * a small model, and the first request is the wrong place to find out.
 *
 * A card prefills its sentence into the composer rather than sending it, so
 * the person makes it theirs ("Lisbon" becomes "Kyoto") before the meester
 * reads it. `typeId` is the project type the sentence must route to; the
 * catalog package's data-contract test holds each one to that against the
 * pinned catalog, so a reworded tag or a renamed type fails there, not on a
 * first run.
 */
export interface FirstProject {
  id: string;
  title: string;
  /** What the person ends up with, in a line. */
  hint: string;
  /** The editable sentence the card puts in the composer. */
  prompt: string;
  typeId: string;
}

export const FIRST_PROJECTS: readonly FirstProject[] = [
  {
    id: 'trip',
    title: 'Plan a trip',
    hint: 'A day-by-day plan and a packing list, on a trip board.',
    prompt: 'Plan a trip to Lisbon next spring for the four of us, about a week.',
    typeId: 'trip-planner',
  },
  {
    id: 'celebration',
    title: 'Plan a celebration',
    hint: 'Guests, budget and the day itself, on one board.',
    prompt: "Plan Dad's 70th birthday party in May, about 30 guests.",
    typeId: 'event-planner',
  },
  {
    id: 'language',
    title: 'Practise a language',
    hint: 'Short role-play scenes with a patient tutor.',
    prompt: 'Start a project to practise Spanish with a language tutor. I know the basics.',
    typeId: 'language-trainer',
  },
];
