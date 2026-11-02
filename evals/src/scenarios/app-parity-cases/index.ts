import type { ParityCase } from '../app-parity.ts';
import booksAndClose from './books-and-close.ts';
import campaignRoom from './campaign-room.ts';
import cashFlowPlanner from './cash-flow-planner.ts';
import clientDelivery from './client-delivery.ts';
import complianceRegister from './compliance-register.ts';
import contentStudio from './content-studio.ts';
import customerVoice from './customer-voice.ts';
import eventDesk from './event-desk.ts';
import grantsAndProposals from './grants-and-proposals.ts';
import hiringDesk from './hiring-desk.ts';
import inventoryReorder from './inventory-reorder.ts';
import newHireOnboarding from './new-hire-onboarding.ts';
import quotesAndBids from './quotes-and-bids.ts';
import salesPipeline from './sales-pipeline.ts';
import shiftRoster from './shift-roster.ts';
import sopLibrary from './sop-library.ts';
import supportDesk from './support-desk.ts';
import teamGoals from './team-goals.ts';
import trainingTracker from './training-tracker.ts';
import vendorContracts from './vendor-contracts.ts';

/** One file per business app; each exports its cases as default. */
export const BUSINESS_PARITY_CASES: ParityCase[] = [
  ...complianceRegister,
  ...hiringDesk,
  ...trainingTracker,
  ...newHireOnboarding,
  ...campaignRoom,
  ...contentStudio,
  ...eventDesk,
  ...clientDelivery,
  ...salesPipeline,
  ...quotesAndBids,
  ...supportDesk,
  ...customerVoice,
  ...vendorContracts,
  ...inventoryReorder,
  ...shiftRoster,
  ...sopLibrary,
  ...teamGoals,
  ...booksAndClose,
  ...cashFlowPlanner,
  ...grantsAndProposals,
];
