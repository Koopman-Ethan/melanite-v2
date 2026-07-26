CREATE TYPE "public"."booking_payment_source" AS ENUM('checkout_link', 'package_redemption', 'comped');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('upcoming', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."checkout_link_status" AS ENUM('pending', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."client_package_status" AS ENUM('active', 'exhausted', 'expired', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('training_certificate', 'supervision_agreement');--> statement-breakpoint
CREATE TYPE "public"."invite_status" AS ENUM('pending', 'accepted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('purchase', 'refund');--> statement-breakpoint
CREATE TYPE "public"."ledger_payer" AS ENUM('client', 'provider', 'student');--> statement-breakpoint
CREATE TYPE "public"."ledger_source" AS ENUM('booking', 'package', 'room_rental', 'membership', 'training');--> statement-breakpoint
CREATE TYPE "public"."ledger_subject_type" AS ENUM('booking', 'client_package', 'room_booking', 'membership', 'training_enrollment');--> statement-breakpoint
CREATE TYPE "public"."medical_director_status" AS ENUM('none', 'active', 'past_due', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."medical_director_type" AS ENUM('melanite', 'own');--> statement-breakpoint
CREATE TYPE "public"."membership_plan" AS ENUM('medical_director');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'past_due', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."provider_role" AS ENUM('platform_owner', 'developer', 'medical_director', 'provider');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('pending', 'active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."room_booking_status" AS ENUM('confirmed', 'cancellation_requested', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."room_slot_type" AS ENUM('full', 'am', 'pm');--> statement-breakpoint
CREATE TYPE "public"."training_course_status" AS ENUM('scheduled', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."training_payment_status" AS ENUM('unpaid', 'partial', 'paid_in_full');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" uuid NOT NULL,
	"provider_service_id" uuid NOT NULL,
	"client_id" uuid,
	"client_name" text NOT NULL,
	"client_phone" text,
	"client_email" text,
	"treatment_area" text,
	"notes" text,
	"original_price" numeric(10, 2) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"payment_source" "booking_payment_source" NOT NULL,
	"duration_mins" integer NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"status" "booking_status" DEFAULT 'upcoming' NOT NULL,
	"google_calendar_event_id" text,
	"policy_ack_at" timestamp with time zone,
	"policy_ack_version" text,
	CONSTRAINT "bookings_time_order" CHECK ("bookings"."end_time" > "bookings"."start_time")
);
--> statement-breakpoint
CREATE TABLE "checkout_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"booking_id" uuid NOT NULL,
	"token" text NOT NULL,
	"status" "checkout_link_status" DEFAULT 'pending' NOT NULL,
	"tip_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"stripe_customer_id" text,
	"stripe_payment_intent_id" text,
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_package_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_package_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"per_session_value" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"qty_total" integer DEFAULT 1 NOT NULL,
	"qty_used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "client_package_items_qty" CHECK ("client_package_items"."qty_used" >= 0 AND "client_package_items"."qty_used" <= "client_package_items"."qty_total")
);
--> statement-breakpoint
CREATE TABLE "client_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"package_template_id" uuid NOT NULL,
	"status" "client_package_status" DEFAULT 'active' NOT NULL,
	"purchased_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text,
	"name" text,
	"phone" text,
	"stripe_customer_id" text
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"doc_type" "document_type" NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text,
	"mime_type" text,
	"size_bytes" integer,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"invited_by_admin_id" uuid NOT NULL,
	"token" text NOT NULL,
	"status" "invite_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "ledger_source" NOT NULL,
	"payer" "ledger_payer" NOT NULL,
	"entry_type" "ledger_entry_type" DEFAULT 'purchase' NOT NULL,
	"subject_type" "ledger_subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"provider_id" uuid,
	"client_id" uuid,
	"service_id" uuid,
	"gross_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"tip_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"provider_payout" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"melanite_cut" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_transfer_id" text,
	"stripe_refund_id" text,
	"stripe_invoice_id" text,
	"payout_status" "payout_status" DEFAULT 'pending' NOT NULL,
	"payout_date" date,
	"note" text,
	CONSTRAINT "ledger_entries_provider_paid_is_unsplit" CHECK ("ledger_entries"."payer" <> 'provider' OR ("ledger_entries"."provider_payout" = 0 AND "ledger_entries"."melanite_cut" = "ledger_entries"."gross_amount"))
);
--> statement-breakpoint
CREATE TABLE "medical_director_credentials" (
	"provider_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"npi" text,
	"license_number" text,
	"license_state" text,
	"license_expiry" date,
	"credentials" text,
	"contact_email" text,
	"contact_phone" text,
	"agreement_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" uuid NOT NULL,
	"plan" "membership_plan" DEFAULT 'medical_director' NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"stripe_subscription_id" text,
	"stripe_customer_id" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"start_date" timestamp with time zone,
	"renewal_date" timestamp with time zone,
	"cancel_date" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "package_checkout_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token" text NOT NULL,
	"package_template_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"client_id" uuid,
	"client_name" text,
	"client_email" text,
	"status" "checkout_link_status" DEFAULT 'pending' NOT NULL,
	"tip_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"stripe_customer_id" text,
	"stripe_payment_intent_id" text,
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_package_id" uuid NOT NULL,
	"client_package_item_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"overall_index" integer NOT NULL,
	"service_index" integer NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "package_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_template_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"per_session_value" numeric(10, 2) DEFAULT '0.00' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"total_price" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"expires_after_days" integer,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"token" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"provider_share_pct" numeric(4, 3) DEFAULT '0.500' NOT NULL,
	"tip_to_provider_pct" numeric(4, 3) DEFAULT '1.000' NOT NULL,
	"no_show_fee_pct_of_price" numeric(4, 3) DEFAULT '0.500' NOT NULL,
	"cancellation_fee_amount" numeric(10, 2) DEFAULT '50.00' NOT NULL,
	"stripe_platform_account_id" text NOT NULL,
	"medical_director_price_id" text,
	"laser_open_time" text DEFAULT '08:00' NOT NULL,
	"laser_close_time" text DEFAULT '20:00' NOT NULL,
	"slot_stride_mins" integer DEFAULT 15 NOT NULL,
	"room_rental_enabled" boolean DEFAULT false NOT NULL,
	"packages_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "platform_settings_singleton" CHECK ("platform_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "provider_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"duration_mins" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"requires_password_reset" boolean DEFAULT false NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text,
	"credentials" text,
	"license_number" text,
	"license_state" text,
	"license_expiry" date,
	"malpractice_insurance" text,
	"role" "provider_role" DEFAULT 'provider' NOT NULL,
	"status" "provider_status" DEFAULT 'pending' NOT NULL,
	"stripe_account_id" text,
	"stripe_onboarding_complete" boolean DEFAULT false NOT NULL,
	"stripe_billing_customer_id" text,
	"medical_director_type" "medical_director_type",
	"medical_director_status" "medical_director_status" DEFAULT 'none' NOT NULL,
	"booking_enabled" boolean DEFAULT false NOT NULL,
	"room_rental_enabled" boolean DEFAULT true NOT NULL,
	"training_cert_document_id" uuid,
	"onboarding_step" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"policy_ack_at" timestamp with time zone,
	"policy_ack_version" text,
	"notify_booking_confirmed" boolean DEFAULT true NOT NULL,
	"notify_payout_deposited" boolean DEFAULT true NOT NULL,
	"notify_appointment_reminders" boolean DEFAULT true NOT NULL,
	"notify_new_availability" boolean DEFAULT true NOT NULL,
	"notify_membership_billing" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" uuid NOT NULL,
	"rental_date" date NOT NULL,
	"slot_type" "room_slot_type" DEFAULT 'full' NOT NULL,
	"price" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"status" "room_booking_status" DEFAULT 'confirmed' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"suggested_duration_mins" integer NOT NULL,
	"min_duration_mins" integer NOT NULL,
	"max_duration_mins" integer NOT NULL,
	"package_eligible" boolean DEFAULT false NOT NULL,
	"advanced_tier_required" boolean DEFAULT false NOT NULL,
	"color_hex" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"day1_date" date NOT NULL,
	"day1_start" text DEFAULT '10:00' NOT NULL,
	"day1_end" text DEFAULT '16:00' NOT NULL,
	"day2_date" date,
	"day2_start" text DEFAULT '10:00' NOT NULL,
	"day2_end" text DEFAULT '14:00' NOT NULL,
	"max_students" integer DEFAULT 5 NOT NULL,
	"deposit_amount" numeric(10, 2) DEFAULT '500.00' NOT NULL,
	"total_price" numeric(10, 2) DEFAULT '1400.00' NOT NULL,
	"google_calendar_event_id_day1" text,
	"google_calendar_event_id_day2" text,
	"status" "training_course_status" DEFAULT 'scheduled' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"training_course_id" uuid NOT NULL,
	"provider_id" uuid,
	"invite_link_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"license_number" text,
	"payment_status" "training_payment_status" DEFAULT 'unpaid' NOT NULL,
	"balance_due_date" date,
	"course_completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destination" text NOT NULL,
	"event_type" text,
	"event_id" text,
	"payload" jsonb,
	"signature_verified" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_service_id_provider_services_id_fk" FOREIGN KEY ("provider_service_id") REFERENCES "public"."provider_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_links" ADD CONSTRAINT "checkout_links_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_package_items" ADD CONSTRAINT "client_package_items_client_package_id_client_packages_id_fk" FOREIGN KEY ("client_package_id") REFERENCES "public"."client_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_package_items" ADD CONSTRAINT "client_package_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_packages" ADD CONSTRAINT "client_packages_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_packages" ADD CONSTRAINT "client_packages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_packages" ADD CONSTRAINT "client_packages_package_template_id_package_templates_id_fk" FOREIGN KEY ("package_template_id") REFERENCES "public"."package_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_invited_by_admin_id_providers_id_fk" FOREIGN KEY ("invited_by_admin_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_director_credentials" ADD CONSTRAINT "medical_director_credentials_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_checkout_links" ADD CONSTRAINT "package_checkout_links_package_template_id_package_templates_id_fk" FOREIGN KEY ("package_template_id") REFERENCES "public"."package_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_checkout_links" ADD CONSTRAINT "package_checkout_links_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_checkout_links" ADD CONSTRAINT "package_checkout_links_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_redemptions" ADD CONSTRAINT "package_redemptions_client_package_id_client_packages_id_fk" FOREIGN KEY ("client_package_id") REFERENCES "public"."client_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_redemptions" ADD CONSTRAINT "package_redemptions_client_package_item_id_client_package_items_id_fk" FOREIGN KEY ("client_package_item_id") REFERENCES "public"."client_package_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_redemptions" ADD CONSTRAINT "package_redemptions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_template_items" ADD CONSTRAINT "package_template_items_package_template_id_package_templates_id_fk" FOREIGN KEY ("package_template_id") REFERENCES "public"."package_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_template_items" ADD CONSTRAINT "package_template_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_templates" ADD CONSTRAINT "package_templates_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_providers_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_bookings" ADD CONSTRAINT "room_bookings_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_training_course_id_training_courses_id_fk" FOREIGN KEY ("training_course_id") REFERENCES "public"."training_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_invite_link_id_invite_links_id_fk" FOREIGN KEY ("invite_link_id") REFERENCES "public"."invite_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_provider_id_start_time_index" ON "bookings" USING btree ("provider_id","start_time");--> statement-breakpoint
CREATE INDEX "bookings_start_time_end_time_index" ON "bookings" USING btree ("start_time","end_time");--> statement-breakpoint
CREATE INDEX "bookings_status_index" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bookings_client_id_index" ON "bookings" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_links_token_index" ON "checkout_links" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_links_booking_id_index" ON "checkout_links" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "checkout_links_status_index" ON "checkout_links" USING btree ("status");--> statement-breakpoint
CREATE INDEX "checkout_links_stripe_payment_intent_id_index" ON "checkout_links" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_package_items_client_package_id_service_id_index" ON "client_package_items" USING btree ("client_package_id","service_id");--> statement-breakpoint
CREATE INDEX "client_packages_client_id_status_index" ON "client_packages" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "client_packages_provider_id_status_index" ON "client_packages" USING btree ("provider_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_email_index" ON "clients" USING btree ("email");--> statement-breakpoint
CREATE INDEX "clients_phone_index" ON "clients" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "documents_provider_id_doc_type_index" ON "documents" USING btree ("provider_id","doc_type");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_links_token_index" ON "invite_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "invite_links_email_index" ON "invite_links" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invite_links_status_index" ON "invite_links" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ledger_entries_created_at_index" ON "ledger_entries" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_entries_provider_id_created_at_index" ON "ledger_entries" USING btree ("provider_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_entries_source_created_at_index" ON "ledger_entries" USING btree ("source","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_entries_subject_type_subject_id_index" ON "ledger_entries" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_client_id_index" ON "ledger_entries" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_payout_status_index" ON "ledger_entries" USING btree ("payout_status");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_stripe_payment_intent_id_entry_type_index" ON "ledger_entries" USING btree ("stripe_payment_intent_id","entry_type") WHERE "ledger_entries"."stripe_payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_stripe_subscription_id_index" ON "memberships" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "memberships_provider_id_status_index" ON "memberships" USING btree ("provider_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "package_checkout_links_token_index" ON "package_checkout_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "package_checkout_links_provider_id_status_index" ON "package_checkout_links" USING btree ("provider_id","status");--> statement-breakpoint
CREATE INDEX "package_checkout_links_stripe_payment_intent_id_index" ON "package_checkout_links" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "package_redemptions_client_package_id_index" ON "package_redemptions" USING btree ("client_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_redemptions_booking_id_index" ON "package_redemptions" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_template_items_package_template_id_service_id_index" ON "package_template_items" USING btree ("package_template_id","service_id");--> statement-breakpoint
CREATE INDEX "package_templates_provider_id_active_index" ON "package_templates" USING btree ("provider_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_index" ON "password_reset_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_provider_id_index" ON "password_reset_tokens" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_services_provider_id_service_id_index" ON "provider_services" USING btree ("provider_id","service_id");--> statement-breakpoint
CREATE INDEX "provider_services_provider_id_is_active_index" ON "provider_services" USING btree ("provider_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_email_index" ON "providers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "providers_status_index" ON "providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "providers_role_index" ON "providers" USING btree ("role");--> statement-breakpoint
CREATE INDEX "providers_stripe_account_id_index" ON "providers" USING btree ("stripe_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_bookings_rental_date_slot_type_index" ON "room_bookings" USING btree ("rental_date","slot_type") WHERE "room_bookings"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "room_bookings_provider_id_index" ON "room_bookings" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "room_bookings_rental_date_index" ON "room_bookings" USING btree ("rental_date");--> statement-breakpoint
CREATE INDEX "services_active_index" ON "services" USING btree ("active");--> statement-breakpoint
CREATE INDEX "training_courses_status_index" ON "training_courses" USING btree ("status");--> statement-breakpoint
CREATE INDEX "training_courses_day1_date_index" ON "training_courses" USING btree ("day1_date");--> statement-breakpoint
CREATE INDEX "training_enrollments_training_course_id_index" ON "training_enrollments" USING btree ("training_course_id");--> statement-breakpoint
CREATE INDEX "training_enrollments_email_index" ON "training_enrollments" USING btree ("email");--> statement-breakpoint
CREATE INDEX "training_enrollments_provider_id_index" ON "training_enrollments" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_event_id_index" ON "webhook_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_index" ON "webhook_events" USING btree ("received_at" DESC NULLS LAST);