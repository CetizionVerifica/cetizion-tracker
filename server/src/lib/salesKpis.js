import { query } from '../db.js';
import { config } from '../config.js';
import { RATES, rateOn } from './salesReport.js';
import { QUOTATION_STATUS, ENQUIRY_STATUS } from './statuses.js';
import { listSalesTargets } from './salesTargets.js';
import { ApiError } from '../middleware/error.js';

const WON_QUOTATION = QUOTATION_STATUS.won;
const LOST_QUOTATION = QUOTATION_STATUS.lost;
const QUOTED_ENQUIRY = ENQUIRY_STATUS.quoted;

/**
 * Validate year parameter and compute half-open interval [from, to)
 * in reporting business timezone.
 */
export function validateReportingYear(yearInput) {
  const year = Number(yearInput);
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError(422, 'Invalid year. Must be an integer between 2000 and 2100');
  }
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  return {
    year,
    from,
    to,
    timeZone: config.businessTimeZone || 'Asia/Kolkata',
  };
}

/**
 * Calculate KPI metrics for a single salesperson.
 *
 * Distinguishes:
 * A. Current ownership workload (present responsibility).
 * B. Historical creation and cohort metrics (verified origin).
 * C. Financial performance (order intake vs unavailable collections).
 */
export async function getSalespersonKpis({ userId, year }) {
  const { year: validatedYear, from, to, timeZone } = validateReportingYear(year);
  const uid = Number(userId);

  // 1. Verify user exists
  const { rows: userRows } = await query(
    'SELECT id, name, email, role, active FROM users WHERE id = $1',
    [uid]
  );
  if (!userRows.length) {
    throw new ApiError(404, 'Salesperson not found');
  }
  const user = userRows[0];

  // 2. Run queries in parallel
  const [
    workloadRes,
    pipelineValueRes,
    cohortRes,
    intakeRes,
    finRemindersRes,
    targets
  ] = await Promise.all([
    // Category A: Current Workload Snapshots (owner_user_id)
    query(
      `SELECT
         (SELECT COUNT(*)::int FROM enquiries
           WHERE owner_user_id = $1 AND status = '${ENQUIRY_STATUS.open}') AS open_enquiries_count,
         (SELECT COUNT(*)::int FROM quotations
           WHERE owner_user_id = $1 AND status NOT IN ('${WON_QUOTATION}', '${LOST_QUOTATION}')) AS open_quotations_count,
         (SELECT COUNT(*)::int FROM projects
           WHERE owner_user_id = $1) AS assigned_projects_count,
         (SELECT COUNT(*)::int FROM projects
           WHERE owner_user_id = $1 AND percent_complete < 1) AS active_projects_count,
         (SELECT COUNT(*)::int FROM projects
           WHERE owner_user_id = $1 AND percent_complete >= 1) AS completed_projects_count`,
      [uid]
    ),

    // Category A: Current Pipeline Value (owner_user_id)
    query(
      `WITH ${RATES}
       SELECT q.currency,
              COALESCE(ROUND(SUM(q.quotation_value), 2), 0) AS total_value,
              COALESCE(ROUND(SUM(q.quotation_value * r.rate), 2), 0) AS value_inr,
              COUNT(*) FILTER (WHERE r.rate IS NULL AND q.currency <> 'INR')::int AS unconverted_count
         FROM quotations q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE q.owner_user_id = $1
          AND q.status NOT IN ('${WON_QUOTATION}', '${LOST_QUOTATION}')
          AND q.quotation_value IS NOT NULL
        GROUP BY q.currency`,
      [uid]
    ),

    // Category B: Historical Creation and Cohort Metrics (originating_user_id / snapshot)
    query(
      `SELECT
         (SELECT COUNT(*)::int FROM enquiries
           WHERE COALESCE(originating_user_id, originating_user_snapshot_id) = $1
             AND enquiry_date >= $2::date AND enquiry_date < $3::date) AS enquiries_created_count,
         (SELECT COUNT(*)::int FROM enquiries
           WHERE COALESCE(originating_user_id, originating_user_snapshot_id) = $1
             AND enquiry_date >= $2::date AND enquiry_date < $3::date
             AND status = '${QUOTED_ENQUIRY}') AS enquiries_cohort_quoted_count,
         (SELECT COUNT(*)::int FROM quotations
           WHERE COALESCE(originating_user_id, originating_user_snapshot_id) = $1
             AND quotation_date >= $2::date AND quotation_date < $3::date) AS quotations_created_count,
         (SELECT COUNT(*)::int FROM quotations
           WHERE COALESCE(originating_user_id, originating_user_snapshot_id) = $1
             AND quotation_date >= $2::date AND quotation_date < $3::date
             AND status = '${WON_QUOTATION}') AS quotations_cohort_won_count,
         (SELECT COUNT(*)::int FROM quotations
           WHERE COALESCE(originating_user_id, originating_user_snapshot_id) = $1
             AND quotation_date >= $2::date AND quotation_date < $3::date
             AND status = '${LOST_QUOTATION}') AS quotations_cohort_lost_count`,
      [uid, from, to]
    ),

    // Category C: Order Intake Value (originating_user_id / snapshot)
    query(
      `WITH ${RATES}
       SELECT COALESCE(ROUND(SUM(q.quotation_value * r.rate), 2), 0) AS order_intake_inr,
              COUNT(*) FILTER (WHERE r.rate IS NULL AND q.currency <> 'INR')::int AS unconverted_deals,
              COALESCE(json_agg(json_build_object('currency', q.currency, 'amount', q.quotation_value))
                       FILTER (WHERE q.quotation_value IS NOT NULL), '[]'::json) AS deals
         FROM quotations q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE COALESCE(q.originating_user_id, q.originating_user_snapshot_id) = $1
          AND q.status = '${WON_QUOTATION}'
          AND q.quotation_date >= $2::date AND q.quotation_date < $3::date`,
      [uid, from, to]
    ),

    // Category A: Current Financial Operations Reminders
    query(
      `SELECT COUNT(*) FILTER (WHERE s.stage_status = 'Overdue')::int   AS overdue_stages,
              COUNT(*) FILTER (WHERE s.stage_status = 'To Invoice')::int AS stages_to_invoice
         FROM v_payment_stages s
        WHERE EXISTS (
          SELECT 1 FROM purchase_orders po
          LEFT JOIN quotations q ON q.quotation_no = po.quotation_no
          LEFT JOIN projects pr  ON pr.project_id = po.project_id
         WHERE po.po_number = s.po_number
           AND (q.owner_user_id = $1 OR pr.owner_user_id = $1)
        )`,
      [uid]
    ),

    // Annual Targets for this user and year
    listSalesTargets(undefined, { salespersonUserId: uid, calendarYear: year })
  ]);

  const workload = workloadRes.rows[0];
  const cohort = cohortRes.rows[0];
  const intake = intakeRes.rows[0];
  const finReminders = finRemindersRes.rows[0];

  const totalPipelineInr = pipelineValueRes.rows.reduce((sum, r) => sum + Number(r.value_inr), 0);
  const totalPipelineCurrencies = pipelineValueRes.rows.map((r) => ({
    currency: r.currency,
    amount: Number(r.total_value),
    value_inr: Number(r.value_inr),
    unconverted: r.unconverted_count > 0,
  }));

  const wonCount = cohort.quotations_cohort_won_count;
  const lostCount = cohort.quotations_cohort_lost_count;
  const closedCount = wonCount + lostCount;
  const cohortWinRate = closedCount > 0 ? Math.round((wonCount / closedCount) * 10000) / 100 : null;

  const enqTotal = cohort.enquiries_created_count;
  const enqQuoted = cohort.enquiries_cohort_quoted_count;
  const enqQuoteRate = enqTotal > 0 ? Math.round((enqQuoted / enqTotal) * 10000) / 100 : null;

  // Actual vs Target comparison
  const targetsWithProgress = targets.map((t) => {
    let actual = null;
    let status = 'supported';
    let note = undefined;

    switch (t.metric) {
      case 'order_intake_value':
        actual = Number(intake.order_intake_inr);
        break;
      case 'won_quotations_count':
        actual = wonCount;
        break;
      case 'enquiries_created_count':
        actual = enqTotal;
        break;
      case 'collections_value':
        status = 'unavailable';
        actual = null;
        note = 'Accurate annual collections require receipt-event data. payment_stages stores cumulative balances with only the latest receipt date and cannot be partitioned across calendar years reliably.';
        break;
      case 'follow_up_completion_rate':
        status = 'unavailable';
        actual = null;
        note = 'Sales CRM follow-up completion rates are unavailable due to lack of a sales follow-up task table.';
        break;
      default:
        status = 'unsupported';
        actual = null;
        note = `Metric '${t.metric}' has no automated calculation in Phase 4.`;
    }

    const variance = actual !== null ? Math.round((actual - t.target_value) * 100) / 100 : null;
    const achievementRate = (actual !== null && t.target_value > 0)
      ? Math.round((actual / t.target_value) * 10000) / 100
      : null;

    return {
      ...t,
      actual,
      variance,
      achievement_percentage: achievementRate,
      status,
      note,
    };
  });

  return {
    salesperson: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
    },
    reporting_period: {
      year: validatedYear,
      from,
      to,
      time_zone: timeZone,
    },
    current_workload: {
      description: 'Current ownership snapshot reflecting active responsibilities. Does not reflect historical sales origin.',
      open_enquiries: workload.open_enquiries_count,
      open_quotations: workload.open_quotations_count,
      pipeline_value_inr: Math.round(totalPipelineInr * 100) / 100,
      pipeline_by_currency: totalPipelineCurrencies,
      assigned_projects: {
        total: workload.assigned_projects_count,
        active: workload.active_projects_count,
        completed: workload.completed_projects_count,
      },
      financial_operations_reminders: {
        description: 'Operational stage reminders under POs linked to currently owned projects/quotations.',
        overdue_stages: finReminders.overdue_stages,
        stages_to_invoice: finReminders.stages_to_invoice,
      },
    },
    historical_cohort_performance: {
      description: 'Creation and outcome cohorts attributed to verified originating salesperson.',
      enquiries_created: enqTotal,
      enquiries_quoted: enqQuoted,
      enquiry_quote_rate_percentage: enqQuoteRate,
      quotations_created: cohort.quotations_created_count,
      quotations_cohort_won: wonCount,
      quotations_cohort_lost: lostCount,
      cohort_win_rate_percentage: cohortWinRate,
    },
    financial_performance: {
      order_intake_inr: Number(intake.order_intake_inr),
      order_intake_unconverted_deals: intake.unconverted_deals,
      collections: {
        status: 'unavailable',
        value: null,
        reason: 'Accurate annual collections require receipt-event data. payment_stages stores cumulative balances with only the latest receipt date and cannot be partitioned across calendar years reliably.',
      },
    },
    crm_follow_ups: {
      status: 'unavailable',
      value: null,
      reason: 'Sales CRM follow-up completion metrics are unavailable due to lack of a sales follow-up task table.',
    },
    targets: targetsWithProgress,
  };
}

/**
 * Team-wide KPI report for administrators.
 * Aggregates team totals, salesperson breakdowns, and separate unassigned / unattributed buckets.
 */
export async function getTeamSalesKpis({ year }) {
  const { year: validatedYear, from, to, timeZone } = validateReportingYear(year);

  // 1. Fetch all salespeople (active and inactive)
  const { rows: salesUsers } = await query(
    `SELECT id, name, email, role, active
       FROM users
      WHERE role = 'sales'
      ORDER BY active DESC, name ASC`
  );

  // 2. Fetch team-wide current pipeline summary (assigned vs unassigned)
  const [pipelineSummaryRes, intakeSummaryRes, conflictRes] = await Promise.all([
    query(
      `WITH ${RATES}
       SELECT CASE WHEN q.owner_user_id IS NULL THEN 'unassigned' ELSE 'assigned' END AS bucket,
              COUNT(*)::int AS quotations_count,
              COALESCE(ROUND(SUM(q.quotation_value * r.rate), 2), 0) AS value_inr
         FROM quotations q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE q.status NOT IN ('${WON_QUOTATION}', '${LOST_QUOTATION}')
        GROUP BY 1`
    ),

    // Cohort Order Intake Summary (attributed to sales vs unattributed)
    query(
      `WITH ${RATES}
       SELECT CASE WHEN COALESCE(q.originating_user_id, q.originating_user_snapshot_id) IS NULL
                   THEN 'unattributed' ELSE 'attributed' END AS bucket,
              COUNT(*)::int AS won_count,
              COALESCE(ROUND(SUM(q.quotation_value * r.rate), 2), 0) AS intake_inr
         FROM quotations q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE q.status = '${WON_QUOTATION}'
          AND q.quotation_date >= $1::date AND q.quotation_date < $2::date
        GROUP BY 1`,
      [from, to]
    ),

    // Conflicting Origin Detection on Purchase Orders
    query(
      `SELECT po.po_number,
              po.project_id,
              po.quotation_no,
              COALESCE(q.originating_user_id, q.originating_user_snapshot_id)  AS quotation_origin_id,
              q.originating_user_name                                         AS quotation_origin_name,
              COALESCE(pr.originating_user_id, pr.originating_user_snapshot_id) AS project_origin_id,
              pr.originating_user_name                                         AS project_origin_name
         FROM purchase_orders po
         JOIN projects pr ON pr.project_id = po.project_id
         LEFT JOIN quotations q ON q.quotation_no = po.quotation_no
        WHERE q.quotation_no IS NOT NULL
          AND COALESCE(q.originating_user_id, q.originating_user_snapshot_id) IS NOT NULL
          AND COALESCE(pr.originating_user_id, pr.originating_user_snapshot_id) IS NOT NULL
          AND COALESCE(q.originating_user_id, q.originating_user_snapshot_id)
              <> COALESCE(pr.originating_user_id, pr.originating_user_snapshot_id)`
    )
  ]);

  // Map individual metrics
  const salespersonReports = await Promise.all(
    salesUsers.map((u) => getSalespersonKpis({ userId: u.id, year: validatedYear }))
  );

  const assignedPipeline = pipelineSummaryRes.rows.find((r) => r.bucket === 'assigned');
  const unassignedPipeline = pipelineSummaryRes.rows.find((r) => r.bucket === 'unassigned');

  const attributedIntake = intakeSummaryRes.rows.find((r) => r.bucket === 'attributed');
  const unattributedIntake = intakeSummaryRes.rows.find((r) => r.bucket === 'unattributed');

  return {
    reporting_period: {
      year: validatedYear,
      from,
      to,
      time_zone: timeZone,
    },
    team_pipeline_summary: {
      assigned_open_quotations: assignedPipeline ? assignedPipeline.quotations_count : 0,
      assigned_pipeline_value_inr: assignedPipeline ? Number(assignedPipeline.value_inr) : 0,
      unassigned_open_quotations: unassignedPipeline ? unassignedPipeline.quotations_count : 0,
      unassigned_pipeline_value_inr: unassignedPipeline ? Number(unassignedPipeline.value_inr) : 0,
      total_open_quotations: (assignedPipeline?.quotations_count || 0) + (unassignedPipeline?.quotations_count || 0),
      total_pipeline_value_inr: Math.round(((Number(assignedPipeline?.value_inr) || 0) + (Number(unassignedPipeline?.value_inr) || 0)) * 100) / 100,
    },
    team_order_intake_summary: {
      attributed_won_quotations: attributedIntake ? attributedIntake.won_count : 0,
      attributed_intake_value_inr: attributedIntake ? Number(attributedIntake.intake_inr) : 0,
      unattributed_won_quotations: unattributedIntake ? unattributedIntake.won_count : 0,
      unattributed_intake_value_inr: unattributedIntake ? Number(unattributedIntake.intake_inr) : 0,
      total_won_quotations: (attributedIntake?.won_count || 0) + (unattributedIntake?.won_count || 0),
      total_intake_value_inr: Math.round(((Number(attributedIntake?.intake_inr) || 0) + (Number(unattributedIntake?.intake_inr) || 0)) * 100) / 100,
    },
    origin_conflict_deals: conflictRes.rows.map((r) => ({
      po_number: r.po_number,
      quotation_no: r.quotation_no,
      project_id: r.project_id,
      quotation_origin_user_id: r.quotation_origin_id,
      quotation_origin_name: r.quotation_origin_name,
      project_origin_user_id: r.project_origin_id,
      project_origin_name: r.project_origin_name,
      resolution_status: 'unresolved_conflict',
      note: 'PO has conflicting verified origins between quotation and project. Financial attribution is left unresolved to avoid arbitrary credit.',
    })),
    salespeople: salespersonReports,
  };
}
