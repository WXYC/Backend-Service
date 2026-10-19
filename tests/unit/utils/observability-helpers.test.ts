import { CompositeReporter } from '@wxyc/observability';
import { createSpyReporter } from '../../utils/observability';

describe('createSpyReporter', () => {
  it('has a spy for exactly the methods of CompositeReporter, so a new ErrorReporter method cannot be missed', () => {
    // `each` is CompositeReporter's private fan-out helper, not part of the ErrorReporter interface.
    const reporterMethods = Object.getOwnPropertyNames(CompositeReporter.prototype)
      .filter((name) => name !== 'constructor' && name !== 'each')
      .sort();
    expect(Object.keys(createSpyReporter()).sort()).toEqual(reporterMethods);
  });
});
