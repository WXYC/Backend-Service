/**
 * Pins the shared `makeTsEvent` fixture to the vendored snapshot of
 * triangle-shows' EventResponse (refresh: README "Refreshing the contract
 * snapshot"). Jest is transpile-only, so `TsEvent` is erased at runtime and
 * the fixture's keys stand in for it: a key the feed never sends (the
 * `source_url` gap of BS#3705) or a required field the fixture omits both fail.
 */
import snapshot from '../../../fixtures/triangle-shows/event-response.schema.json';
import { makeTsEvent } from './fixtures';

const properties = Object.keys(snapshot.properties);

describe('makeTsEvent vs the vendored EventResponse snapshot', () => {
  it('sets only keys the fork sends', () => {
    expect(Object.keys(makeTsEvent()).filter((k) => !properties.includes(k))).toEqual([]);
  });

  it('sets every required EventResponse property', () => {
    const set = Object.keys(makeTsEvent());
    expect(snapshot.required.filter((k) => !set.includes(k))).toEqual([]);
  });
});
