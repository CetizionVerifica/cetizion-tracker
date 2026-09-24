import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
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
export function ChartCard({ title, meta, columns, rows, footnote, children, height = 260 }) {
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

/** Recharts calls this per tick; a category axis that truncates is a lie. */
export const axisTick = { fill: 'var(--secondary-text)', fontSize: 12 };
