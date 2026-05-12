import { CorrelationContext } from './correlation.context';

describe('CorrelationContext', () => {
  let ctx: CorrelationContext;

  beforeEach(() => {
    ctx = new CorrelationContext();
  });

  it('returns a fresh UUID outside of any scope', () => {
    const a = ctx.current();
    const b = ctx.current();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b); // each call gets its own id when unscoped
  });

  it('binds the id inside run()', () => {
    ctx.run('corr-1', () => {
      expect(ctx.current()).toBe('corr-1');
    });
  });

  it('propagates through awaited async work', async () => {
    await ctx.run('corr-async', async () => {
      await Promise.resolve();
      expect(ctx.current()).toBe('corr-async');
      await new Promise<void>((r) => setImmediate(r));
      expect(ctx.current()).toBe('corr-async');
    });
  });

  it('nested scopes shadow the outer scope; the outer id is restored on exit', () => {
    ctx.run('outer', () => {
      expect(ctx.current()).toBe('outer');
      ctx.run('inner', () => {
        expect(ctx.current()).toBe('inner');
      });
      expect(ctx.current()).toBe('outer');
    });
  });

  it('sibling scopes do not bleed into each other', async () => {
    const ids: string[] = [];
    await Promise.all([
      ctx.run('a', async () => {
        await Promise.resolve();
        ids.push(ctx.current());
      }),
      ctx.run('b', async () => {
        await Promise.resolve();
        ids.push(ctx.current());
      }),
    ]);
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});
