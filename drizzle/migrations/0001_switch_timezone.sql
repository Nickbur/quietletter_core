-- Each switch carries the IANA zone of the device that last saved it: the check-in cadence steps on
-- its calendar and the warning email shows the fire time on its clock. Existing rows stay NULL —
-- they keep stepping in the process zone (the old behaviour) and the email prints UTC until the
-- app saves them again.
ALTER TABLE "quietletter_switches" ADD COLUMN "timezone" varchar(64);
