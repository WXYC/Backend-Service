export { parseSesEvent } from './parse-ses-event.js';
export { emitSesEventSpan } from './emit-span.js';
export { validateSnsMessage, type ValidatedSnsMessage } from './sns-validator.js';
export { confirmSubscription } from './confirm-subscription.js';
export type {
  SesEvent,
  SesEventKind,
  SesSendEvent,
  SesDeliveryEvent,
  SesBounceEvent,
  SesComplaintEvent,
  SesRejectEvent,
  SesDeliveryDelayEvent,
} from './types.js';
