import {
  type ExperimentSpec,
  __register,
  __reset,
  assign,
  saltFor,
} from '@dif.sh/sdk';
import type {
  Adapter,
  ReadonlyHeaders,
  ReadonlyRequestCookies,
} from 'flags';
import { flag } from 'flags/next';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import {
  DIF_OVERRIDES_COOKIE,
  DIF_UID_COOKIE,
  type DifEntities,
  createDifAdapter,
  difAdapter,
  getProviderData,
} from './index';

function register(
  id: string,
  weights: Record<string, number>,
  extra: Partial<ExperimentSpec> = {},
): void {
  __register({
    id,
    surface: 'home',
    variants: Object.keys(weights),
    salt: saltFor(id),
    weights,
    exclusionGroup: null,
    created: '2026-01-01',
    audience: () => true,
    ...extra,
  });
}

function request(cookies: Record<string, string> = {}): {
  headers: ReadonlyHeaders;
  cookies: ReadonlyRequestCookies;
} {
  const jar = new Map(Object.entries(cookies));
  return {
    headers: new Headers() as unknown as ReadonlyHeaders,
    cookies: {
      get: (name: string) =>
        jar.has(name) ? { name, value: jar.get(name) } : undefined,
      has: (name: string) => jar.has(name),
      getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
    } as unknown as ReadonlyRequestCookies,
  };
}

const USERS = Array.from({ length: 200 }, (_, i) => `user-${i}`);

beforeEach(() => {
  __reset();
});

afterEach(() => {
  __reset();
  vi.restoreAllMocks();
});

describe('variant()', () => {
  it('returns the same variant as the SDK assign() for every user id', () => {
    register('home-hero-cta', { control: 50, variant_a: 50 });
    const adapter = createDifAdapter().variant();
    const seen = new Set<string>();

    for (const userId of USERS) {
      const expected = assign('home-hero-cta', { userId, attributes: {} })!
        .variant;
      const fromEntities = adapter.decide({
        key: 'home-hero-cta',
        entities: { userId },
        ...request(),
      });
      const fromCookie = adapter.decide({
        key: 'home-hero-cta',
        ...request({ [DIF_UID_COOKIE]: userId }),
      });
      expect(fromEntities).toBe(expected);
      expect(fromCookie).toBe(expected);
      seen.add(expected as string);
    }

    expect(seen).toEqual(new Set(['control', 'variant_a']));
  });

  it('serves the first declared variant for a null userId without an exposure', () => {
    register('home-hero-cta', { control: 0, variant_a: 100 });
    const onExposure = vi.fn();
    const adapter = createDifAdapter({ onExposure }).variant();

    expect(
      adapter.decide({
        key: 'home-hero-cta',
        entities: { userId: null },
        ...request(),
      }),
    ).toBe('control');
    expect(adapter.decide({ key: 'home-hero-cta', ...request() })).toBe(
      'control',
    );
    expect(onExposure).not.toHaveBeenCalled();
  });

  it('serves the first declared variant on an audience miss without an exposure', () => {
    register(
      'pro-banner',
      { control: 0, variant_a: 100 },
      { audience: (attrs) => attrs.plan === 'pro' },
    );
    const onExposure = vi.fn();
    const adapter = createDifAdapter({ onExposure }).variant();

    expect(
      adapter.decide({
        key: 'pro-banner',
        entities: { userId: 'u1', attributes: { plan: 'free' } },
        ...request(),
      }),
    ).toBe('control');
    expect(onExposure).not.toHaveBeenCalled();

    expect(
      adapter.decide({
        key: 'pro-banner',
        entities: { userId: 'u1', attributes: { plan: 'pro' } },
        ...request(),
      }),
    ).toBe('variant_a');
    expect(onExposure).toHaveBeenCalledTimes(1);
    expect(onExposure).toHaveBeenCalledWith({
      key: 'pro-banner',
      variant: 'variant_a',
      bucket: expect.any(Number),
      userId: 'u1',
    });
  });

  it('forces a variant from the _dif cookie and does not call onExposure', () => {
    register('home-hero-cta', { control: 100, variant_a: 0 });
    const onExposure = vi.fn();
    const adapter = createDifAdapter({ onExposure }).variant();

    for (const value of [
      'home-hero-cta=variant_a',
      'other=x,home-hero-cta=variant_a',
      encodeURIComponent('home-hero-cta=variant_a'),
    ]) {
      expect(
        adapter.decide({
          key: 'home-hero-cta',
          ...request({ [DIF_UID_COOKIE]: 'u1', [DIF_OVERRIDES_COOKIE]: value }),
        }),
      ).toBe('variant_a');
    }
    expect(onExposure).not.toHaveBeenCalled();
  });

  it('ignores a _dif force for an undeclared variant', () => {
    register('home-hero-cta', { control: 100, variant_a: 0 });
    const adapter = createDifAdapter().variant();

    expect(
      adapter.decide({
        key: 'home-hero-cta',
        ...request({
          [DIF_UID_COOKIE]: 'u1',
          [DIF_OVERRIDES_COOKIE]: 'home-hero-cta=nope',
        }),
      }),
    ).toBe('control');
  });

  it('ignores the _dif cookie when overrides is false', () => {
    register('home-hero-cta', { control: 100, variant_a: 0 });
    const onExposure = vi.fn();
    const adapter = createDifAdapter({ overrides: false, onExposure }).variant();

    expect(
      adapter.decide({
        key: 'home-hero-cta',
        ...request({
          [DIF_UID_COOKIE]: 'u1',
          [DIF_OVERRIDES_COOKIE]: 'home-hero-cta=variant_a',
        }),
      }),
    ).toBe('control');
    expect(onExposure).toHaveBeenCalledTimes(1);
  });

  it('throws an error naming the generated client and dif build for an unknown key', () => {
    const adapter = createDifAdapter().variant();

    expect(() =>
      adapter.decide({ key: 'missing-flag', ...request() }),
    ).toThrowError(
      /No dif experiment is registered for flag "missing-flag".*import '\.\/dif\/generated\/client'.*`dif build`/,
    );
  });

  it('returns the decision when onExposure throws or rejects', async () => {
    register('home-hero-cta', { control: 0, variant_a: 100 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const throwing = createDifAdapter({
      onExposure: () => {
        throw new Error('sink down');
      },
    }).variant();
    expect(
      throwing.decide({
        key: 'home-hero-cta',
        entities: { userId: 'u1' },
        ...request(),
      }),
    ).toBe('variant_a');

    const rejecting = createDifAdapter({
      onExposure: () => Promise.reject(new Error('sink down')),
    }).variant();
    expect(
      rejecting.decide({
        key: 'home-hero-cta',
        entities: { userId: 'u1' },
        ...request(),
      }),
    ).toBe('variant_a');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveBeenCalledWith(
      '@flags-sdk/dif: onExposure threw',
      expect.any(Error),
    );
    expect(errors).toHaveBeenCalledWith(
      '@flags-sdk/dif: onExposure rejected',
      expect.any(Error),
    );
  });
});

describe('isEnabled()', () => {
  it('is true for "on" and false for "off" in an off/on flag', () => {
    register('rollout-on', { off: 0, on: 100 });
    register('rollout-off', { off: 100, on: 0 });
    const adapter = createDifAdapter().isEnabled();

    for (const userId of USERS.slice(0, 20)) {
      const req = { entities: { userId }, ...request() };
      expect(adapter.decide({ key: 'rollout-on', ...req })).toBe(true);
      expect(adapter.decide({ key: 'rollout-off', ...req })).toBe(false);
    }
  });

  it('is true whenever a control/variant_a experiment assigns variant_a', () => {
    register('checkout-cta-v2', { control: 50, variant_a: 50 });
    const adapter = createDifAdapter().isEnabled();
    const values = new Set<boolean>();

    for (const userId of USERS) {
      const expected =
        assign('checkout-cta-v2', { userId, attributes: {} })!.variant !==
        'control';
      const value = adapter.decide({
        key: 'checkout-cta-v2',
        entities: { userId },
        ...request(),
      });
      expect(value).toBe(expected);
      values.add(value as boolean);
    }
    expect(values).toEqual(new Set([true, false]));
  });

  it('with { on } is true only for that variant', () => {
    register('pricing', { control: 34, variant_a: 33, variant_b: 33 });
    const adapter = createDifAdapter().isEnabled({ on: 'variant_b' });

    for (const userId of USERS) {
      const expected =
        assign('pricing', { userId, attributes: {} })!.variant === 'variant_b';
      expect(
        adapter.decide({ key: 'pricing', entities: { userId }, ...request() }),
      ).toBe(expected);
    }
  });

  it('with { on } throws for an undeclared variant', () => {
    register('pricing', { control: 50, variant_a: 50 });
    const adapter = createDifAdapter().isEnabled({ on: 'variant_z' });

    expect(() =>
      adapter.decide({
        key: 'pricing',
        entities: { userId: 'u1' },
        ...request(),
      }),
    ).toThrowError(/"variant_z" is not a declared variant of "pricing"/);
  });

  it('is false for a null userId and a forced first variant', () => {
    register('rollout', { off: 0, on: 100 });
    const onExposure = vi.fn();
    const adapter = createDifAdapter({ onExposure }).isEnabled();

    expect(adapter.decide({ key: 'rollout', ...request() })).toBe(false);
    expect(
      adapter.decide({
        key: 'rollout',
        ...request({ [DIF_UID_COOKIE]: 'u1', [DIF_OVERRIDES_COOKIE]: 'rollout=off' }),
      }),
    ).toBe(false);
    expect(onExposure).not.toHaveBeenCalled();
  });
});

describe('identify', () => {
  it('reads userId from the dif_uid cookie', async () => {
    expect(
      await difAdapter.identify(request({ [DIF_UID_COOKIE]: 'u1' })),
    ).toEqual({ userId: 'u1', attributes: {} });
    expect(await difAdapter.identify(request())).toEqual({
      userId: null,
      attributes: {},
    });
  });

  it('honors cookieName', async () => {
    const { identify } = createDifAdapter({ cookieName: 'anon_id' });
    expect(await identify(request({ anon_id: 'u2', dif_uid: 'u1' }))).toEqual({
      userId: 'u2',
      attributes: {},
    });
  });

  it('is attached to the adapters so flags without identify use it', () => {
    const dif = createDifAdapter();
    expect(dif.variant().identify).toBe(dif.identify);
    expect(dif.isEnabled().identify).toBe(dif.identify);
  });
});

describe('adapter metadata', () => {
  it('shares one adapterId per factory', () => {
    const a = createDifAdapter();
    const b = createDifAdapter();
    expect(a.variant().adapterId).toBeDefined();
    expect(a.variant().adapterId).toBe(a.isEnabled().adapterId);
    expect(a.variant().adapterId).not.toBe(b.variant().adapterId);
  });

  it('sets origin only when provided', () => {
    const origin = (key: string) => `https://github.com/acme/app/blob/main/dif/experiments/active/${key}.md`;
    expect(createDifAdapter({ origin }).variant().origin).toBe(origin);
    expect('origin' in createDifAdapter().isEnabled()).toBe(false);
  });

  it('returns objects that satisfy the Flags SDK Adapter type', () => {
    expectTypeOf(difAdapter.variant()).toMatchTypeOf<
      Adapter<string, DifEntities>
    >();
    expectTypeOf(difAdapter.variant<'control' | 'variant_a'>()).toMatchTypeOf<
      Adapter<'control' | 'variant_a', DifEntities>
    >();
    expectTypeOf(difAdapter.isEnabled()).toMatchTypeOf<
      Adapter<boolean, DifEntities>
    >();
  });
});

describe('getProviderData', () => {
  it('lists every registered experiment with its variants, surface, and weights', () => {
    register('home-hero-cta', { control: 50, variant_a: 50 });
    register(
      'new-checkout',
      { off: 90, on: 10 },
      { surface: 'checkout', exclusionGroup: 'checkout-copy' },
    );

    expect(getProviderData()).toEqual({
      definitions: {
        'home-hero-cta': {
          options: [
            { value: 'control', label: 'control' },
            { value: 'variant_a', label: 'variant_a' },
          ],
          description:
            'Surface: home. Weights: control 50%, variant_a 50%. Fallback: control.',
        },
        'new-checkout': {
          options: [
            { value: 'off', label: 'off' },
            { value: 'on', label: 'on' },
          ],
          description:
            'Surface: checkout. Weights: off 90%, on 10%. Fallback: off. Exclusion group: checkout-copy.',
        },
      },
      hints: [],
    });
  });

  it('applies a string or function origin', () => {
    register('home-hero-cta', { control: 50, variant_a: 50 });

    expect(
      getProviderData({ origin: 'https://github.com/acme/app' }).definitions[
        'home-hero-cta'
      ]?.origin,
    ).toBe('https://github.com/acme/app');
    expect(
      getProviderData({ origin: (key) => `https://example.com/${key}.md` })
        .definitions['home-hero-cta']?.origin,
    ).toBe('https://example.com/home-hero-cta.md');
  });

  it('emits boolean options for flags with a boolean defaultValue', () => {
    register('new-checkout', { off: 90, on: 10 });
    register('home-hero-cta', { control: 50, variant_a: 50 });
    const flags = {
      newCheckoutFlag: flag<boolean, DifEntities>({
        key: 'new-checkout',
        defaultValue: false,
        adapter: difAdapter.isEnabled(),
      }),
      heroCtaFlag: flag<string, DifEntities>({
        key: 'home-hero-cta',
        defaultValue: 'control',
        adapter: difAdapter.variant(),
      }),
      precomputed: ['not', 'a', 'flag'],
    };

    const { definitions } = getProviderData({ flags });
    expect(definitions['new-checkout']?.options).toEqual([
      { value: false, label: 'Disabled (off)' },
      { value: true, label: 'Enabled' },
    ]);
    expect(definitions['home-hero-cta']?.options).toEqual([
      { value: 'control', label: 'control' },
      { value: 'variant_a', label: 'variant_a' },
    ]);
  });

  it('adds a hint when nothing is registered', () => {
    const data = getProviderData();
    expect(data.definitions).toEqual({});
    expect(data.hints).toEqual([
      { key: 'dif/empty-registry', text: expect.stringContaining('dif build') },
    ]);
  });
});

describe('with flag() from flags/next', () => {
  // Passing a Request makes flags/next read headers from it instead of
  // importing `next/headers`, so no Next.js runtime is needed.
  function nextRequest(cookie?: string): Request {
    return new Request('https://example.com/', {
      headers: cookie ? { cookie } : {},
    });
  }

  it('resolves through identify, decide, and the dif_uid cookie header', async () => {
    register('new-checkout', { off: 0, on: 100 });
    register('home-hero-cta', { control: 50, variant_a: 50 });
    const newCheckout = flag<boolean, DifEntities>({
      key: 'new-checkout',
      defaultValue: false,
      adapter: difAdapter.isEnabled(),
    });
    const heroCta = flag<string, DifEntities>({
      key: 'home-hero-cta',
      defaultValue: 'control',
      adapter: difAdapter.variant(),
    });

    expect(await newCheckout(nextRequest('dif_uid=u1'))).toBe(true);
    expect(await newCheckout(nextRequest())).toBe(false);
    for (const userId of USERS.slice(0, 20)) {
      expect(await heroCta(nextRequest(`dif_uid=${userId}`))).toBe(
        assign('home-hero-cta', { userId, attributes: {} })!.variant,
      );
    }
  });

  it('honors a URL-encoded _dif cookie from a real cookie header', async () => {
    register('new-checkout', { off: 0, on: 100 });
    const newCheckout = flag<boolean, DifEntities>({
      key: 'new-checkout',
      defaultValue: true,
      adapter: difAdapter.isEnabled(),
    });

    expect(
      await newCheckout(
        nextRequest(`dif_uid=u1; _dif=${encodeURIComponent('new-checkout=off')}`),
      ),
    ).toBe(false);
  });

  it('falls back to defaultValue when decide throws for an unknown key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const missing = flag<boolean, DifEntities>({
      key: 'missing-flag',
      defaultValue: false,
      adapter: difAdapter.isEnabled(),
    });
    const missingNoDefault = flag<boolean, DifEntities>({
      key: 'missing-flag',
      adapter: difAdapter.isEnabled(),
    });

    expect(await missing(nextRequest('dif_uid=u1'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'flags: Flag "missing-flag" is falling back to its defaultValue after catching the following error',
      expect.objectContaining({
        message: expect.stringContaining("import './dif/generated/client'"),
      }),
    );
    await expect(missingNoDefault(nextRequest('dif_uid=u2'))).rejects.toThrow(
      /dif build/,
    );
  });
});
