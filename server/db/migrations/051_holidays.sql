-- Working days (#73): the days nobody at Cetizion works, so a date that
-- counts working days can skip them. Weekends are not listed; the helpers
-- in businessDate.ts already skip Saturday and Sunday.
CREATE TABLE IF NOT EXISTS holidays (
  id          serial PRIMARY KEY,
  holiday_on  date NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- India's gazetted holidays for Central Government offices at Delhi/New
-- Delhi, as published by DoPT: 2026 from O.M. F.No.12/2/2023-JCA of
-- 3 July 2025, 2027 from the O.M. of the same number of 16 July 2026. The
-- dates of Id-ul-Fitr, Id-ul-Zuha, Muharram and Milad-un-Nabi follow the
-- moon and can move; correct them in Settings → Holidays when they do.
-- Weekend holidays are kept so the list reads like the published one.
INSERT INTO holidays (holiday_on, name) VALUES
  ('2026-01-26', 'Republic Day'),
  ('2026-03-04', 'Holi'),
  ('2026-03-21', 'Id-ul-Fitr'),
  ('2026-03-26', 'Ram Navami'),
  ('2026-03-31', 'Mahavir Jayanti'),
  ('2026-04-03', 'Good Friday'),
  ('2026-05-01', 'Buddha Purnima'),
  ('2026-05-27', 'Id-ul-Zuha (Bakrid)'),
  ('2026-06-26', 'Muharram'),
  ('2026-08-15', 'Independence Day'),
  ('2026-08-26', 'Milad-un-Nabi'),
  ('2026-09-04', 'Janmashtami'),
  ('2026-10-02', 'Mahatma Gandhi''s Birthday'),
  ('2026-10-20', 'Dussehra'),
  ('2026-11-08', 'Diwali'),
  ('2026-11-24', 'Guru Nanak''s Birthday'),
  ('2026-12-25', 'Christmas Day'),
  ('2027-01-26', 'Republic Day'),
  ('2027-03-10', 'Id-ul-Fitr'),
  ('2027-03-23', 'Holi'),
  ('2027-03-26', 'Good Friday'),
  ('2027-04-15', 'Ram Navami'),
  ('2027-04-19', 'Mahavir Jayanti'),
  ('2027-05-17', 'Id-ul-Zuha (Bakrid)'),
  ('2027-05-20', 'Buddha Purnima'),
  ('2027-06-16', 'Muharram'),
  -- Two holidays on one day in 2027; one row, since a date is a holiday or not.
  ('2027-08-15', 'Independence Day; Milad-un-Nabi'),
  ('2027-08-25', 'Janmashtami'),
  ('2027-10-02', 'Mahatma Gandhi''s Birthday'),
  ('2027-10-09', 'Dussehra'),
  ('2027-10-29', 'Diwali'),
  ('2027-11-14', 'Guru Nanak''s Birthday'),
  ('2027-12-25', 'Christmas Day')
ON CONFLICT (holiday_on) DO NOTHING;
