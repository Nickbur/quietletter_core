-- Each switch carries the UI language of the app that last saved it: the owner's check-in warning
-- and the recipients' emails are written in it (Russian for `ru`, else English). Existing rows stay
-- NULL (English) until the app fills them in (`PUT /v1/switches/:id/regional`) or saves them again.
ALTER TABLE "quietletter_switches" ADD COLUMN "locale" varchar(16);
