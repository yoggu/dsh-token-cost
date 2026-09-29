/**
 * Browser half of `dsh-token-cost`: one readout at the right edge
 * of the ambient statistics row below the composer.
 *
 * Hand-written in the `window.__ModuleLoader__.load` format — no JSX, no
 * bundler — and declared through `exports["./client"]` plus `dsh.client` in
 * package.json, which is how the host discovers and serves a browser bundle.
 *
 * The readout renders the host's Session projection through the standard
 * projection hook: the host owns the price, the framework pushes a whole value
 * whenever a durable settlement changes it, and the readout itself issues no
 * requests and runs no timer. A key that carries no value reads `undefined`,
 * which is exactly the "nothing can be priced yet" state.
 *
 * @module dsh-token-cost/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-cost',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createPortal } = require('react-dom')

    // Match the host Tooltip surface without importing private UI components.
    function PillTooltip({ anchor, text, visible, id }) {
      const ref = React.useRef(null);
      const [pos, setPos] = React.useState(null);
      React.useEffect(() => {
        if (!visible) { setPos(null); return; }
        const timer = setTimeout(() => {
          const a = anchor.current?.getBoundingClientRect();
          const tip = ref.current;
          if (a && tip) setPos({ left: Math.max(8, Math.min(a.left + a.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8)), top: Math.max(8, a.top - tip.offsetHeight - 6) });
        }, 350);
        const hide = () => setPos(null);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        const key = e => { if (e.key === 'Escape') hide(); };
        document.addEventListener('keydown', key);
        return () => { clearTimeout(timer); window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); document.removeEventListener('keydown', key); };
      }, [visible, text]);
      return visible ? createPortal(React.createElement('span', {ref, id, role:'tooltip', style:{
        position:'fixed', zIndex:1100, width:'max-content', maxWidth:'50vw', boxSizing:'border-box',
        padding:'3px 7px', borderRadius:'var(--dsw-radius-sm)', background:'var(--dsw-alias-tooltip-bg)',
        color:'var(--dsw-static-neutral-bluish-00)', fontFamily:'inherit', fontSize:13, lineHeight:'20px',
        whiteSpace:'pre-line', overflowWrap:'break-word', pointerEvents:'none',
        visibility:pos ? 'visible' : 'hidden', left:pos?.left ?? 0, top:pos?.top ?? 0,
      }}, text), document.body) : null;
    }

    /** The projection key the host half registers. */
    const PROJECTION_KEY = 'dsh-token-cost.cost'

    /** Stand-in for a slot context that does not carry the projection hook. */
    const noProjection = () => undefined

    /**
     * Render the estimate like pi coding-agent: fixed three decimals and a
     * subscription marker where the route is covered by a plan rather than a
     * per-request account charge.
     * @param value - the estimated amount in USD.
     * @param subscription - whether the route is subscription-covered.
     * @returns the display string.
     */
    function usd(value, subscription) {
      const amount = Number.isFinite(value) && value >= 0 ? value : 0
      return `$${amount.toFixed(3)}${subscription ? ' (sub)' : ''}`
    }

    /** The short label for the current-session estimate. */
    function detail(state) {
      return state.subscription ? 'Estimated cost · subscription' : 'Estimated cost'
    }

    /**
     * The readout: subscribes to the host's Session projection.
     *
     * `steps` counts the settlements behind the number, so a Session that has
     * priced nothing is shown as unavailable instead of a confident zero.
     *
     * @param props - the slot props, carrying the standard projection hook.
     * @returns the readout element.
     */
    function TokenCostEstimate(props) {
      const anchor = React.useRef(null)
      const tipId = React.useId()
      const [hover, setHover] = React.useState(false)
      // The hook is a stable framework seat for this component's lifetime; the
      // fallback keeps a context without it renderable instead of throwing.
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : noProjection
      const projected = useProjection(PROJECTION_KEY)
      const state = projected !== null && typeof projected === 'object' && Number(projected.steps) > 0 ? projected : null

      return React.createElement(
        'span',
        {
          className: CLASS_NAME,
          ref: anchor, tabIndex: 0,
          onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
          onFocus: () => setHover(true), onBlur: () => setHover(false),
          'aria-describedby': hover ? tipId : undefined,
          // Only completeness opacity is dynamic; responsive placement stays
          // in the stylesheet so narrow screens can put it on a second line.
          style: {
            opacity: state === null ? 0.5 : state.unpriced > 0 ? 0.75 : 1,
          },
        },
        state === null ? '$0.000' : usd(state.usd, state.subscription),
        React.createElement(PillTooltip, {anchor, id:tipId, visible:hover, text:state === null ? 'Cost estimate unavailable' : detail(state)}),
      )
    }

    /** Stable class the readout's stylesheet and its width rules address. */
    const CLASS_NAME = 'dsh-token-cost'

    /**
     * The readout's stylesheet.
     *
     * The dock's host layout is a centered flex row. The price is registered
     * after the stats and cache entries; on desktop it appears at their right,
     * with the same subdued typography. On narrow screens the dock wraps the
     * price below the stats rather than overlapping controls.
     */
    const STYLESHEET = `
.dsh-token-cost{display:inline-flex;align-items:center;box-sizing:border-box;max-width:100%;flex:0 0 auto;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));padding:1px 8px}
@media (max-width:720px){div:has(> [data-slot="conversation.composer.dock"] .dsh-token-cost){flex-wrap:wrap;gap:0 4px}div:has(> [data-slot="conversation.composer.dock"] .dsh-token-cost) [data-composer-stats]{flex:0 0 100%;justify-content:center}div:has(> [data-slot="conversation.composer.dock"] .dsh-token-cost) > :last-child:not([data-slot]){margin-left:auto}.dsh-token-cost{font-size:12px}}
`

    /**
     * Register after the native stats and cache cells in the ambient dock.
     * The additive slot leaves the shipped statistics intact.
     *
     * @param ctx - the plugin's Cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = CLASS_NAME
        style.textContent = STYLESHEET
        document.head.appendChild(style)
        return () => style.remove()
      })
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'cost',
        order: 20,
      }, TokenCostEstimate))
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
