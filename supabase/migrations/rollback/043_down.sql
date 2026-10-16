-- Rollback for 043: drops the WhatsApp checkout order store. The checkout Flow then can't hand
-- orders to the engine (the endpoint fails closed); typed chat ordering is unaffected.

drop table if exists public.whatsapp_flow_orders;
