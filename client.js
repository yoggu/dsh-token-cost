/**
 * Browser half of `dsh-cost-pill`: one pill beside the token-usage pill at the
 * bottom of the conversation.
 *
 * Hand-written in the `window.__ModuleLoader__.load` format — no JSX, no
 * bundler — and declared through `exports["./client"]` plus `dsh.client` in
 * package.json, which is how the host discovers and serves a browser bundle.
 *
 * The pill reads its number from the exact route the host half registers. It
 * never computes a price itself: which steps are settled, which are estimated,
 * and which have no price at all is the host's answer, and the pill only marks
 * the difference so a lower bound is never read as a total.
 *
 * @module dsh-cost-pill/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-cost-pill',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Exact route the host half registers for this package. */
    const ROUTE = '/api/dsh-cost-pill'

    /** How often the pill re-reads the host's answer. */
    const POLL_MS = 2000

    /**
     * Render a USD amount without ever rounding a real charge away.
     * @param value - the amount in USD.
     * @returns the display string.
     */
    function usd(value) {
      if (!Number.isFinite(value) || value <= 0) return '$0.00'
      for (let digits = 2; digits <= 6; digits += 1) {
        const text = value.toFixed(digits)
        if (Number(text) > 0) return `$${text}`
      }
      return '<$0.000001'
    }

    /**
     * The prefix that states how complete the amount is.
     * @param state - the host's report.
     * @returns the marker, or an empty string for a settled total.
     */
    function marker(state) {
      if (state.unpriced > 0) return '\u2265 '
      if (state.pending > 0 || state.estimated > 0) return '\u2248 '
      return ''
    }

    /**
     * The tooltip: what the number is made of, and what is still missing.
     * @param state - the host's report.
     * @returns the explanation.
     */
    function detail(state) {
      const total = state.exact + state.estimated + state.unpriced
      const parts = [`Billed cost from OpenRouter generation records (${state.exact} of ${total} steps settled)`]
      if (state.pending > 0) parts.push(`${state.pending} still being looked up`)
      const listed = state.listPrice ?? 0
      const live = state.estimated - listed
      if (live > 0) parts.push(`${live} currently estimated from live rates`)
      if (listed > 0) parts.push(`${listed} estimated at published list price, not billed`)
      if (state.unpriced > 0) parts.push(`${state.unpriced} unpriced, so this is a lower bound`)
      parts.push(state.routes.join(', '))
      return parts.join(' \u00b7 ')
    }

    /**
     * The pill: polls the host route for the current Session.
     * @param props - the slot props, carrying the Session id.
     * @returns the pill element, or null while nothing can be priced.
     */
    function CostPill(props) {
      const [state, setState] = React.useState(null)
      const [note, setNote] = React.useState('starting')
      const sessionId = props.sessionId === undefined ? '' : String(props.sessionId)
      React.useEffect(() => {
        let alive = true
        const tick = () => {
          fetch(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`).then((response) => {
            if (!response.ok) throw new Error(String(response.status))
            return response.json()
          }).then((value) => {
            if (!alive) return
            setState(value)
            setNote(value === null ? `no price yet (session ${sessionId === '' ? 'missing' : sessionId})` : 'ok')
          }).catch((error) => {
            if (!alive) return
            setState(null)
            setNote(`request failed: ${String(error)}`)
          })
        }
        tick()
        const handle = window.setInterval(tick, POLL_MS)
        return () => window.clearInterval(handle)
      }, [sessionId])

      return React.createElement(
        'span',
        {
          className: CLASS_NAME,
          title: state === null ? `dsh-cost-pill: ${note}` : detail(state),
          // Only the completeness opacity is dynamic; everything else lives in
          // the stylesheet, because an inline `display` would outrank the rules
          // that take the readout out of a row too narrow to hold it.
          style: {
            opacity: state === null ? 0.5 : state.unpriced > 0 ? 0.75 : 1,
          },
        },
        state === null ? '$—' : marker(state) + usd(state.usd),
      )
    }

    /** Stable class the readout's stylesheet and its width rules address. */
    const CLASS_NAME = 'dsh-cost-pill'

    /**
     * The readout's stylesheet.
     *
     * The composer's tool row wraps once it runs out of width, and a wrapped
     * row puts the send control on a line of its own — the readout is worth
     * less than the controls it displaces, so it steps aside instead. The
     * container query answers for the composer's own width, which is what
     * actually runs out; the viewport query covers a container the query
     * cannot see, such as a phone whose composer is not an inline-size
     * container.
     */
    const STYLESHEET = `
.dsh-cost-pill{display:inline-flex;align-items:center;box-sizing:border-box;max-width:100%;flex:0 0 auto;gap:4px;white-space:nowrap;color:var(--dsw-alias-label-tertiary,inherit);font:var(--dsw-font-xs-13,inherit);font-variant-numeric:tabular-nums;line-height:1.2}
@container (width<=620px){.dsh-cost-pill{display:none}}
@media (max-width:700px){.dsh-cost-pill{display:none}}
`

    /**
     * Register the readout among the composer's compact controls.
     *
     * The ambient stats row below the composer card is one single cell that
     * lays its own pills out in a row, so a second cell there would always
     * start its own line; the tool row is a real row of independent controls,
     * which is what keeps this readout on one line.
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
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'cost',
        order: 5,
      }, CostPill))
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
