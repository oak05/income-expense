-- 0003: optional monthly budget per expense category (app v1.3). NULL = no budget.

ALTER TABLE categories ADD COLUMN budget_satang INTEGER CHECK (budget_satang IS NULL OR budget_satang > 0);
