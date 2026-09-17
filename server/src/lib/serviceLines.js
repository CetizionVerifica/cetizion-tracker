/**
 * Service lines for the sales review PDF. The service on a quotation or an
 * enquiry is free text ("EcoVadis, ISO 37001", "Ecovadis & Other Services"),
 * so it is matched against keywords. A bundled service matches every line it
 * names, so the lines can add up to more than the quotations.
 */

export const SERVICE_LINES = [
  { name: 'EcoVadis', pattern: /eco\s*vadis/i },
  { name: 'ISO certification & management systems', pattern: /\biso(?![a-z])|\bsa\s*8000\b/i },
  {
    name: 'ASI / Copper Mark / LME',
    pattern: /\basi\b|copper\s*mark|\blme\b|chain\s+of\s+custody|\bcoc\b|\bjdd\b|responsible\s+sourcing/i,
  },
  {
    name: 'Sustainability reporting & assurance',
    pattern: /\bsr\b|\bbrsr\b|\bgri\b|\bcsr\b|sustainability\s+(report|assessment)|reasonable\s+assurance|limited\s+assurance|assurance\s+for/i,
  },
  {
    name: 'Social & supply-chain audits',
    pattern: /\bpsci\b|living\s+wage|modern\s+slavery|social|smeta|sedex|supply[\s-]*chain|human\s+rights|ethical/i,
  },
  {
    name: 'Climate & environment (GHG / LCA / CBAM)',
    pattern: /\bghg\b|\blca\b|\bcbam\b|carbon|decarboni[sz]|\bsbti\b|scope\s*[123]\b|climate|net[\s-]*zero|emission/i,
  },
  { name: 'HSE / process safety', pattern: /hazop|hazard|\bhse\b|process\s+safety|fire\s+safety/i },
  { name: 'ESG strategy & advisory', pattern: /\besg\b|strategy|advisory|materiality/i },
];

export const OTHER_SERVICE = 'Other services';
export const NO_SERVICE = 'No service entered';

/** The service lines a service text belongs to — at least one. */
export function serviceLinesFor(text) {
  const value = String(text ?? '').trim();
  if (!value) return [NO_SERVICE];
  const lines = SERVICE_LINES.filter((line) => line.pattern.test(value)).map((line) => line.name);
  return lines.length ? lines : [OTHER_SERVICE];
}
