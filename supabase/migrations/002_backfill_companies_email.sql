-- 002_backfill_companies_email.sql
-- Copies each company's auth email into the new companies.email column.
--
-- Joins on id, which is how company-signup.html creates the row
-- (insert({ id: u.id, ... })), so companies.id == auth.users.id.
--
-- Run once in the Supabase SQL editor. Already applied to production.
--
-- NOTE: the Supabase SQL editor can report this update as "no rows returned"
-- even when it succeeded. That is the editor rendering a zero-count update,
-- not a failure. Confirm with:
--   select count(*) as total, count(email) as with_email from companies;

update companies c
set email = u.email
from auth.users u
where c.id = u.id
  and c.email is null;
