import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip } from './ui/chart.tsx';
import { Table as TableIcon, BarChart3 } from 'lucide-react';
import { Button } from './ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.tsx';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx';
import { useMediaQuery } from '../lib/hooks.js';

/**
 * Below this, Recharts starts dropping the value labels and every other
 * axis tick to make room, and a bar chart with no numbers on it is
 * decoration. So the twin is what a phone opens on — the same toggle is
 * still there for anyone who wants the picture.
 */
const CHART_NEEDS = '(min-width: 640px)';

/**
 * A chart with a table twin (#22).
 *
 * Every figure on Reports is shown twice: once as bars, once as a real
 * table. The toggle is not a courtesy — a bar is a picture, and a picture
 * cannot be read aloud, tabbed into or copied into an email. So:
 *
 *  - in chart mode the chart is `aria-hidden` and the twin is still in the
 *    DOM, visually hidden, as plain text. A screen reader always gets the
 *    numbers without being asked to press anything first.
 *  - the visually-hidden twin carries no links, because a link nobody can
 *    see is a tab stop into nowhere. Pressing "Open as table" is the
 *    keyboard path to the same places the bars go, and the hint says so.
 *
 * Rows are `{ key, cells: [...strings], href? }`, so the twin is built from
 * the same array the chart is and cannot drift away from it.
 */
export function ChartCard({ title, meta, columns, rows, footnote, children, height = 260, actions }) {
  const roomForAChart = useMediaQuery(CHART_NEEDS);
  const [chosen, setChosen] = useState(null);
  const asTable = chosen ?? !roomForAChart;
  const captionId = useId();
  const linked = rows.some((row) => row.href);

  return (
    <Card className="gap-4">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          {/* `flex-1` so a long second line shrinks instead of shoving the
              toggle onto a row of its own in one card and not the others. */}
          <div className="min-w-0 flex-1">
            <CardTitle className="text-[15px]">{title}</CardTitle>
            {meta && <CardDescription className="mt-0.5">{meta}</CardDescription>}
          </div>
          {actions}
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={asTable}
            onClick={() => setChosen(!asTable)}
            className="shrink-0"
          >
            {asTable
              ? <><BarChart3 className="size-3.5" strokeWidth={1.75} aria-hidden="true" /> Show the chart</>
              : <><TableIcon className="size-3.5" strokeWidth={1.75} aria-hidden="true" /> Open as table</>}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {asTable ? (
          <Table>
            {/* The card header already says both of these; the caption is
                here so the table has an accessible name, not to print the
                title twice under it. */}
            <TableCaption className="sr-only">{title} — {meta}</TableCaption>
            <TableHeader>
              <TableRow>
                {columns.map((col, i) => (
                  <TableHead key={col} scope="col" className={i === 0 ? '' : 'text-right'}>{col}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  {row.cells.map((cell, i) => (
                    <TableCell key={columns[i]} className={i === 0 ? 'font-medium' : 'text-right tabular-nums'}>
                      {i === 0 && row.href ? <Link to={row.href}>{cell}</Link> : cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <>
            <div aria-hidden="true" style={{ height }}>{children}</div>
            <table className="sr-only">
              <caption id={captionId}>{title} — {meta}</caption>
              <thead><tr>{columns.map((col) => <th key={col} scope="col">{col}</th>)}</tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>{row.cells.map((cell, i) => <td key={columns[i]}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </CardContent>
      {(footnote || linked) && (
        <div className="px-6 text-[12px] text-muted-foreground">
          {footnote}
          {linked && !asTable && <> Open it as a table to follow any row with the keyboard.</>}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------- chart style
 *
 * The shared look for every chart on Reports, ported from sales-tracker's
 * chart-kit so the two products' dashboards read the same way. Four
 * decisions, and the reason each one is not a matter of taste:
 *
 *   recessive axes   a tick label is a reference, not content. They sit at
 *                    --muted-foreground with no axis line and no tick mark,
 *                    so the bars are the only thing with weight.
 *   one grid, one    gridlines run across the value axis only — the
 *   direction        category axis gets none, because a line between two
 *                    named rows implies an order that is not there.
 *   square baseline  a bar is rounded at the data end and square where it
 *                    meets the axis. Rounding both ends detaches it from
 *                    its own baseline and makes small values look larger.
 *   value first      in the tooltip the number leads and the series name
 *                    follows, muted, because the number is what was asked
 *                    for. The colour key is a 2px rule, not a filled
 *                    swatch, so it reads as a line on a chart.
 *
 * These are objects rather than a component because Recharts wants props:
 * `<XAxis {...AXIS} />` is the whole point.
 */

/** Axis ticks: readable, and nothing else. */
export const AXIS = {
  tick: { fill: 'var(--muted-foreground)', fontSize: 12 },
  axisLine: false,
  tickLine: false,
};

/** Gridlines. Pass `horizontal={false}` or `vertical={false}` to pick one. */
export const GRID = { stroke: 'var(--border)', strokeWidth: 1 };

/**
 * Bar geometry. `up` for columns, `right` for rows; `size` caps the width
 * so four bars in a wide card do not become four slabs, and `paired` is the
 * narrower cap for a chart showing two series per category.
 */
export const BAR = {
  size: 24,
  paired: 16,
  up: [4, 4, 0, 0],
  right: [0, 4, 4, 0],
};

/** The band under the pointer. Named so a chart cannot invent its own. */
export const HOVER = { fill: 'var(--accent)' };

/** A value label sitting off the end of a bar. */
export const BAR_LABEL = { fill: 'var(--muted-foreground)', fontSize: 11 };

/**
 * The tooltip: the value in full, then what it is.
 *
 * Recharts hands this `active`, `payload` and `label`. `format` turns a
 * value into its display string, and `names` renames a series where the
 * dataKey is not what a person would call it. A series whose value is null
 * is dropped rather than shown as an empty line.
 */
export function ChartTip({ active, payload, label, format = (value) => value, names = {}, title }) {
  if (!active || !payload?.length) return null;
  const shown = payload.filter((item) => item?.value !== null && item?.value !== undefined);
  if (!shown.length) return null;

  return (
    <div className="rounded-[var(--radius)] border bg-popover px-3 py-2 text-[13px] text-popover-foreground shadow-md">
      <p className="mb-1 text-muted-foreground">{title ?? label}</p>
      {shown.map((item) => {
        const key = item.dataKey ?? item.name;
        return (
          <p key={key} className="flex items-center gap-2">
            {item.color && (
              <span aria-hidden="true" className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: item.color }} />
            )}
            <span className="num font-semibold">{format(item.value, key, item.payload)}</span>
            <span className="text-muted-foreground">{names[key] ?? item.name ?? key}</span>
          </p>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- shared shapes */

const ROW_HEIGHT = 34;
const CHART_MIN_HEIGHT = 180;

/** The height a row chart needs for `rows` bars, so none is squeezed. */
export const ROW_CHART = (rows) => Math.max(CHART_MIN_HEIGHT, rows * ROW_HEIGHT + 24);

// A stage or a band with nothing in it is an answer — "no money is over
// ninety days late" is the best line on the page. Recharts draws a zero bar
// as nothing at all and puts its label nowhere, so every bar keeps two
// pixels and its ₹0 stays where the reader expects it.
export const ZERO_BAR = 2;

/** Ageing escalates: not late, late, properly late. Red is only for the last. */
export const AGE_COLOUR = { 'not-due': 'var(--forecast)', '1-30': 'var(--waiting)', '31-60': 'var(--waiting)', '61-90': 'var(--late)', '90+': 'var(--late)' };

/** Money expected in, firmest first. The weighted pipeline is its own, lighter band. */
export const CASH_BANDS = [
  { key: 'received', label: 'Received', colour: 'var(--settled)' },
  { key: 'invoiced', label: 'Invoiced, due', colour: 'var(--waiting)' },
  { key: 'scheduled', label: 'Not yet invoiced', colour: 'var(--forecast)' },
];

/**
 * Stages read top to bottom as a funnel: one row each, the bar as long as
 * its value, the count beside the name. Recharts' own FunnelChart centres
 * its trapezoids and loses the labels, which is the part that matters.
 *
 * Rows are `{ key, label, value, count, colour? }`.
 */
export function FunnelBars({ rows, format, onOpen, valueName = 'value' }) {
  const data = rows.map((r) => ({ ...r, name: `${r.label} (${r.count})` }));
  return (
    <ChartContainer config={{ value: { label: valueName } }} className="h-full w-full aspect-auto">
      <BarChart data={data} layout="vertical" margin={{ left: 4, right: 64, top: 4, bottom: 4 }}>
        <CartesianGrid {...GRID} horizontal={false} />
        <XAxis type="number" dataKey="value" {...AXIS} tickFormatter={format} />
        <YAxis type="category" dataKey="name" width={170} {...AXIS} />
        <ChartTooltip cursor={HOVER} content={<ChartTip format={format} names={{ value: valueName }} />} />
        <Bar dataKey="value" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} cursor={onOpen ? 'pointer' : undefined} onClick={(bar) => bar?.payload && onOpen?.(bar.payload)}>
          {data.map((r) => <Cell key={r.key} fill={r.colour || 'var(--primary)'} />)}
          <LabelList dataKey="value" position="right" formatter={format} {...BAR_LABEL} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
