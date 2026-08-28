// @vitest-environment node

/**
 * Tests for api/_lib/daily-report.ts — the EOD report builder.
 *
 * The sql client is INJECTED into buildDailyReport, so no module mocks are
 * needed: the mock below is a tagged-template function routed by statement
 * CONTENT (regex on the joined template strings), which makes the tests
 * independent of query execution order — the builder runs its sections in
 * parallel. Composed WHERE fragments (gexCtDayFilter) contain no FROM and
 * are returned inertly, mirroring how the real driver composes them.
 */

import { describe, it, expect } from 'vitest';

import { buildDailyReport } from '../_lib/daily-report.js';

type Sql = Parameters<typeof buildDailyReport>[0];
type Rows = Record<string, unknown>[];
type RouteSpec = Rows | Error;

const DATE = '2026-08-27';

/**
 * Ordered content matchers — first match wins, so the more specific
 * pattern for a table precedes the generic `FROM <table>` one.
 */
const ROUTE_MATCHERS = [
  ['session', /array_agg\(open/],
  ['dqCandles', /FROM index_candles_1m/],
  ['cone', /FROM cone_levels/],
  ['breaches', /FROM cone_breach_events/],
  ['playbookLatest', /key_levels/],
  ['playbookCounts', /FROM periscope_analyses/],
  ['spotExposures', /FROM spot_exposures/],
  ['zeroGamma', /FROM zero_gamma_levels/],
  ['topStrikes', /last_tick/],
  ['dqGex', /FROM gex_strike_0dte/],
  ['flowCloses', /DISTINCT ON \(source\)/],
  ['etfTide', /array_agg\(ncp \+ npp/],
  ['dqFlow', /FROM flow_data/],
  ['tapeAgg', /whale_count/],
  ['topPrints', /ORDER BY price::float8 \* size \* 100 DESC/],
  ['dqWs', /FROM ws_option_trades/],
  ['lottery', /FROM lottery_finder_fires/],
  ['periscopeLottery', /FROM periscope_lottery_fires/],
  ['gammaSetups', /FROM ws_gamma_setup_fires/],
  ['silentBoom', /FROM silent_boom_alerts/],
] as const;

type RouteKey = (typeof ROUTE_MATCHERS)[number][0];

function happyRoutes(): Record<RouteKey, RouteSpec> {
  return {
    session: [
      {
        candle_count: 390,
        session_low: 6440,
        session_high: 6478,
        session_open: 6450,
        session_close: 6467,
      },
    ],
    dqCandles: [{ n: 780 }],
    cone: [{ cone_lower: 6438.5, cone_upper: 6482.5 }],
    breaches: [],
    playbookLatest: [
      {
        mode: 'intraday',
        slot_captured_at: '2026-08-27T20:50:00Z',
        bias: 'two-sided',
        regime_tag: 'chop',
        confidence: 'medium',
        gamma_floor: 6440,
        gamma_ceiling: 6480,
        magnet: 6465,
        charm_zero: 6460,
        trade_types_recommended: ['fade-extremes'],
        trade_types_avoided: ['breakout-chase'],
        narrative: 'Dealers long gamma; expect chop into the close.',
      },
    ],
    playbookCounts: [{ complete: 38, failed: 2 }],
    spotExposures: [
      {
        net_gamma_mm: -1200,
        net_charm_mm: 300,
        net_vanna_mm: -50,
        price: 6466.5,
      },
    ],
    zeroGamma: [
      { zero_gamma: 6455.25, spot: 6466.5, ts: '2026-08-27T19:59:00Z' },
    ],
    topStrikes: [
      { strike: 6470, net_gamma_mm: 900 },
      { strike: 6450, net_gamma_mm: -600 },
    ],
    dqGex: [{ n: 23000 }],
    flowCloses: [
      { source: 'market_tide', ncp: 1_200_000_000, npp: 800_000_000 },
      { source: 'spx_flow', ncp: 500_000_000, npp: 200_000_000 },
      { source: 'spy_flow', ncp: 90, npp: 40 },
      { source: 'qqq_flow', ncp: 10, npp: 30 },
      { source: 'zero_dte_index', ncp: 5, npp: 2 },
    ],
    etfTide: [
      { source: 'spy_etf_tide', earliest: 100, latest: 350 },
      { source: 'qqq_etf_tide', earliest: -50, latest: -80 },
    ],
    dqFlow: [{ n: 1500 }],
    tapeAgg: [{ whale_count: 42, whale_premium: 69_000_000, sweep_count: 913 }],
    topPrints: [
      {
        ticker: 'SPXW',
        option_type: 'C',
        strike: 6470,
        expiry: '2026-08-27',
        premium: 2_400_000,
        side: 'ask',
      },
      {
        ticker: 'NVDA',
        option_type: 'P',
        strike: 175,
        expiry: '2026-09-19',
        premium: 1_900_000,
        side: 'bid',
      },
      {
        ticker: 'SPY',
        option_type: 'C',
        strike: 646,
        expiry: '2026-08-27',
        premium: 1_100_000,
        side: 'mid',
      },
    ],
    dqWs: [{ n: 250_000 }],
    lottery: [{ fires: 3919, enriched: 3919, wins: 700, losses: 2800 }],
    periscopeLottery: [{ fires: 4, locked: 4, wins: 2 }],
    gammaSetups: [{ fires: 1, resolved: 1, wins: 1 }],
    silentBoom: [{ alerts: 120, enriched: 120, wins: 18 }],
  };
}

function makeSql(overrides: Partial<Record<RouteKey, RouteSpec>> = {}): Sql {
  const spec = { ...happyRoutes(), ...overrides };
  const fn = (strings: TemplateStringsArray) => {
    const joined = strings.join(' ');
    // Composed WHERE fragments (gexCtDayFilter) have no FROM — return the
    // text inertly; the outer statement is what gets routed.
    if (!/\bFROM\b/i.test(joined)) return joined;
    const hit = ROUTE_MATCHERS.find(([, re]) => re.test(joined));
    if (!hit) {
      return Promise.reject(new Error(`Unrouted SQL: ${joined.slice(0, 120)}`));
    }
    const out = spec[hit[0]];
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve(out);
  };
  (fn as unknown as { unsafe: (s: string) => string }).unsafe = (s) => s;
  return fn as unknown as Sql;
}

function allFailRoutes(): Record<RouteKey, RouteSpec> {
  const spec = {} as Record<RouteKey, RouteSpec>;
  for (const [key] of ROUTE_MATCHERS) spec[key] = new Error('db down');
  return spec;
}

describe('buildDailyReport', () => {
  it('assembles every section and the headline on a full day', async () => {
    const report = await buildDailyReport(makeSql(), DATE);

    expect(report.date).toBe(DATE);
    expect(Date.parse(report.generatedAt)).not.toBeNaN();
    expect(report.headline).toBe(
      'SPX 6467 · range 38pts (0.6%) · bias two-sided · net GEX -$1.2B · ' +
        'cone held · 3919 fires',
    );

    expect(report.session).toEqual({
      open: 6450,
      high: 6478,
      low: 6440,
      close: 6467,
      rangePts: 38,
      rangePct: (38 / 6467) * 100,
      candleCount: 390,
      cone: { lower: 6438.5, upper: 6482.5, closedInside: true },
      coneBreaches: [],
    });

    expect(report.playbook).toEqual({
      mode: 'intraday',
      slotCapturedAt: '2026-08-27T20:50:00Z',
      bias: 'two-sided',
      regime: 'chop',
      confidence: 'medium',
      gammaFloor: 6440,
      gammaCeiling: 6480,
      magnet: 6465,
      charmZero: 6460,
      recommended: ['fade-extremes'],
      avoid: ['breakout-chase'],
      narrative: 'Dealers long gamma; expect chop into the close.',
      slotsComplete: 38,
      slotsFailed: 2,
    });

    expect(report.positioning).toEqual({
      netGammaMM: -1200,
      netCharmMM: 300,
      netVannaMM: -50,
      spotAtLast: 6466.5,
      zeroGamma: {
        level: 6455.25,
        spot: 6466.5,
        ts: '2026-08-27T19:59:00Z',
      },
      topStrikes: [
        { strike: 6470, netGammaMM: 900 },
        { strike: 6450, netGammaMM: -600 },
      ],
    });

    expect(report.flow).toEqual({
      marketTide: { ncp: 1_200_000_000, npp: 800_000_000 },
      netFlowClose: { spx: 300_000_000, spy: 50, qqq: -20 },
      etfTideDelta: { spy: 250, qqq: -30 },
      zeroDteNet: 3,
      tape: {
        whaleCount: 42,
        whalePremium: 69_000_000,
        sweepCount: 913,
        topPrints: [
          {
            ticker: 'SPXW',
            optionType: 'C',
            strike: 6470,
            expiry: '2026-08-27',
            premium: 2_400_000,
            side: 'ask',
          },
          {
            ticker: 'NVDA',
            optionType: 'P',
            strike: 175,
            expiry: '2026-09-19',
            premium: 1_900_000,
            side: 'bid',
          },
          {
            ticker: 'SPY',
            optionType: 'C',
            strike: 646,
            expiry: '2026-08-27',
            premium: 1_100_000,
            side: 'mid',
          },
        ],
      },
    });

    expect(report.signals).toEqual({
      lottery: {
        fires: 3919,
        enriched: 3919,
        wins: 700,
        losses: 2800,
        partial: false,
      },
      periscopeLottery: { fires: 4, locked: 4, wins: 2 },
      gammaSetups: { fires: 1, resolved: 1, wins: 1 },
      silentBoom: { alerts: 120, enriched: 120, wins: 18 },
    });

    expect(report.dataQuality).toEqual({
      spxCandles: 780,
      gexTicks: 23000,
      flowRows: 1500,
      wsTrades: 250_000,
      playbookSlots: { complete: 38, failed: 2 },
      notes: [],
    });
  });

  it('reports a breached cone in the headline', async () => {
    const sql = makeSql({
      breaches: [
        {
          direction: 'lower',
          breach_time: '2026-08-27T15:31:00Z',
          pts_past_bound: 4.25,
        },
      ],
      session: [
        {
          candle_count: 390,
          session_low: 6410,
          session_high: 6470,
          session_open: 6450,
          session_close: 6420,
        },
      ],
    });
    const report = await buildDailyReport(sql, DATE);
    expect(report.session?.cone?.closedInside).toBe(false);
    expect(report.session?.coneBreaches).toEqual([
      {
        direction: 'lower',
        breachTime: '2026-08-27T15:31:00Z',
        ptsPastBound: 4.25,
      },
    ]);
    expect(report.headline).toContain('cone breached down');
  });

  it('nulls the session and notes it when the candle query fails', async () => {
    const sql = makeSql({ session: new Error('relation missing') });
    const report = await buildDailyReport(sql, DATE);
    expect(report.session).toBeNull();
    expect(report.dataQuality.notes).toContain('session: relation missing');
    // The rest of the report is intact.
    expect(report.playbook).not.toBeNull();
    expect(report.positioning).not.toBeNull();
    expect(report.flow).not.toBeNull();
    expect(report.signals).not.toBeNull();
    expect(report.headline).toBe(
      'bias two-sided · net GEX -$1.2B · 3919 fires',
    );
  });

  it('nulls the playbook (and zeroes its slots) when its query fails', async () => {
    const sql = makeSql({ playbookLatest: new Error('pg timeout') });
    const report = await buildDailyReport(sql, DATE);
    expect(report.playbook).toBeNull();
    expect(report.dataQuality.playbookSlots).toEqual({
      complete: 0,
      failed: 0,
    });
    expect(report.dataQuality.notes).toContain('playbook: pg timeout');
    expect(report.session).not.toBeNull();
  });

  it('nulls positioning and notes it when spot_exposures fails', async () => {
    const sql = makeSql({ spotExposures: new Error('boom') });
    const report = await buildDailyReport(sql, DATE);
    expect(report.positioning).toBeNull();
    expect(report.dataQuality.notes).toContain('positioning: boom');
    expect(report.headline).not.toContain('net GEX');
  });

  it('nulls flow and notes it when flow_data fails', async () => {
    const sql = makeSql({ flowCloses: new Error('flow down') });
    const report = await buildDailyReport(sql, DATE);
    expect(report.flow).toBeNull();
    expect(report.dataQuality.notes).toContain('flow: flow down');
  });

  it('nulls signals and notes it when a signal table fails', async () => {
    const sql = makeSql({ lottery: new Error('no lottery') });
    const report = await buildDailyReport(sql, DATE);
    expect(report.signals).toBeNull();
    expect(report.dataQuality.notes).toContain('signals: no lottery');
    expect(report.headline).not.toContain('fires');
  });

  it('keeps flow but nulls the tape when only ws_option_trades fails', async () => {
    const sql = makeSql({ tapeAgg: new Error('tape gone') });
    const report = await buildDailyReport(sql, DATE);
    expect(report.flow).not.toBeNull();
    expect(report.flow?.tape).toBeNull();
    expect(report.flow?.marketTide).toEqual({
      ncp: 1_200_000_000,
      npp: 800_000_000,
    });
    expect(report.dataQuality.notes).toContain('tape: tape gone');
  });

  it('keeps the session but nulls the cone when cone_levels fails', async () => {
    const sql = makeSql({ cone: new Error('cone missing') });
    const report = await buildDailyReport(sql, DATE);
    expect(report.session).not.toBeNull();
    expect(report.session?.cone).toBeNull();
    expect(report.session?.coneBreaches).toEqual([]);
    expect(report.dataQuality.notes).toContain('cone: cone missing');
    expect(report.headline).not.toContain('cone');
  });

  it('fails a data-quality count soft to 0 with a note', async () => {
    const sql = makeSql({ dqCandles: new Error('count broke') });
    const report = await buildDailyReport(sql, DATE);
    expect(report.dataQuality.spxCandles).toBe(0);
    expect(report.dataQuality.gexTicks).toBe(23000);
    expect(report.dataQuality.notes).toContain('dq.spxCandles: count broke');
  });

  it('still materializes the report when every query fails', async () => {
    const report = await buildDailyReport(makeSql(allFailRoutes()), DATE);
    expect(report.date).toBe(DATE);
    expect(report.session).toBeNull();
    expect(report.playbook).toBeNull();
    expect(report.positioning).toBeNull();
    expect(report.flow).toBeNull();
    expect(report.signals).toBeNull();
    expect(report.headline).toBe(`No data for ${DATE}`);
    expect(report.dataQuality).toEqual({
      spxCandles: 0,
      gexTicks: 0,
      flowRows: 0,
      wsTrades: 0,
      playbookSlots: { complete: 0, failed: 0 },
      notes: expect.arrayContaining([
        'session: db down',
        'playbook: db down',
        'positioning: db down',
        'flow: db down',
        'signals: db down',
        'dq.spxCandles: db down',
        'dq.gexTicks: db down',
        'dq.flowRows: db down',
        'dq.wsTrades: db down',
      ]),
    });
  });

  it('flags lottery enrichment as partial while enriched < fires', async () => {
    const sql = makeSql({
      lottery: [{ fires: 3919, enriched: 2000, wins: 400, losses: 1500 }],
    });
    const report = await buildDailyReport(sql, DATE);
    expect(report.signals?.lottery).toEqual({
      fires: 3919,
      enriched: 2000,
      wins: 400,
      losses: 1500,
      partial: true,
    });
  });

  it('handles an empty day with nulls and zeros, without throwing', async () => {
    const zeroCount: Rows = [{ n: 0 }];
    const sql = makeSql({
      session: [
        {
          candle_count: 0,
          session_low: null,
          session_high: null,
          session_open: null,
          session_close: null,
        },
      ],
      dqCandles: zeroCount,
      cone: [],
      breaches: [],
      playbookLatest: [],
      playbookCounts: [{ complete: 0, failed: 0 }],
      spotExposures: [],
      zeroGamma: [],
      topStrikes: [],
      dqGex: zeroCount,
      flowCloses: [],
      etfTide: [],
      dqFlow: zeroCount,
      tapeAgg: [{ whale_count: 0, whale_premium: 0, sweep_count: 0 }],
      topPrints: [],
      dqWs: zeroCount,
      lottery: [{ fires: 0, enriched: 0, wins: 0, losses: 0 }],
      periscopeLottery: [{ fires: 0, locked: 0, wins: 0 }],
      gammaSetups: [{ fires: 0, resolved: 0, wins: 0 }],
      silentBoom: [{ alerts: 0, enriched: 0, wins: 0 }],
    });
    const report = await buildDailyReport(sql, DATE);
    expect(report.session).toBeNull();
    expect(report.playbook).toBeNull();
    expect(report.positioning).toBeNull();
    expect(report.flow).toBeNull();
    expect(report.signals).toEqual({
      lottery: { fires: 0, enriched: 0, wins: 0, losses: 0, partial: false },
      periscopeLottery: { fires: 0, locked: 0, wins: 0 },
      gammaSetups: { fires: 0, resolved: 0, wins: 0 },
      silentBoom: { alerts: 0, enriched: 0, wins: 0 },
    });
    expect(report.dataQuality).toEqual({
      spxCandles: 0,
      gexTicks: 0,
      flowRows: 0,
      wsTrades: 0,
      playbookSlots: { complete: 0, failed: 0 },
      notes: [],
    });
    expect(report.headline).toBe('0 fires');
  });

  it('coerces string NUMERIC values a mock (or driver edge) hands back', async () => {
    // Belt-and-braces: the SQL casts should make these numbers already,
    // but the builder must not trust that blindly (see CLAUDE.md history).
    const sql = makeSql({
      spotExposures: [
        {
          net_gamma_mm: '-1200.00',
          net_charm_mm: '300.5',
          net_vanna_mm: null,
          price: '6466.50',
        },
      ],
    });
    const report = await buildDailyReport(sql, DATE);
    expect(report.positioning?.netGammaMM).toBe(-1200);
    expect(report.positioning?.netCharmMM).toBe(300.5);
    expect(report.positioning?.netVannaMM).toBeNull();
    expect(report.positioning?.spotAtLast).toBe(6466.5);
    expect(report.headline).toContain('net GEX -$1.2B');
  });
});
