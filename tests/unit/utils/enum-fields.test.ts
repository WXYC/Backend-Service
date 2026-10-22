import { validateEnumField } from '../../../apps/backend/utils/text-fields';
import { REQUEST_MODES } from '../../../apps/backend/services/flowsheet/request-mode';
import { SPOTLIGHT_ROLES, validateSpotlightRole } from '../../../apps/backend/services/flowsheet/spotlight';
import { requestLineModeEnum, spotlightRoleEnum } from '../../../shared/database/src/schema';
import WxycError from '../../../apps/backend/utils/error';

describe('validateEnumField', () => {
  it('derives the value lists from the schema enums', () => {
    expect([...REQUEST_MODES]).toEqual([...requestLineModeEnum.enumValues]);
    expect([...SPOTLIGHT_ROLES]).toEqual([...spotlightRoleEnum.enumValues]);
  });

  it.each([
    ['request_mode', 'requests', REQUEST_MODES, false, true],
    ['request_mode', 'closed', REQUEST_MODES, false, true],
    ['request_mode', 'bogus', REQUEST_MODES, false, false],
    ['request_mode', 7, REQUEST_MODES, false, false],
    ['request_mode', null, REQUEST_MODES, true, true],
    ['request_mode', null, REQUEST_MODES, false, false],
    ['spotlight_role', 'performer', SPOTLIGHT_ROLES, false, true],
    ['spotlight_role', 'host', SPOTLIGHT_ROLES, false, true],
    ['spotlight_role', 'bogus', SPOTLIGHT_ROLES, false, false],
    ['spotlight_role', 7, SPOTLIGHT_ROLES, false, false],
    ['spotlight_role', null, SPOTLIGHT_ROLES, true, true],
    ['spotlight_role', null, SPOTLIGHT_ROLES, false, false],
  ] as const)('%s=%p nullable=%p', (field, value, values, nullable, ok) => {
    const run = () => validateEnumField(value, field, values, { nullable });
    if (ok) {
      expect(run()).toBe(value);
      return;
    }
    expect(run).toThrow(WxycError);
    expect(run).toThrow(`${field} must be one of ${values.join(', ')}${nullable ? ', or null' : ''}`);
  });

  it('validateSpotlightRole throws for an unknown role', () => {
    expect(() => validateSpotlightRole('bogus')).toThrow(
      'spotlight_role must be one of performer, dj, reader, guest, host'
    );
  });
});
