// Provider accounts plus the admin account.
table providers {
  auth = true

  schema {
    uuid id
    timestamp joined_at?=now {
      visibility = "private"
    }
  
    // Email address of the provider
    email email filters=trim|lower
  
    // Password hash of the provider.
    password password_hash {
      sensitive = true
    }
  
    // First name of provider
    text first_name filters=trim
  
    // Last name of the provider.
    text last_name filters=trim
  
    // Phone number of the provider.
    text? phone? filters=trim
  
    text? credentials? filters=trim
  
    // License number of the provider.
    text? license_number? filters=trim
  
    // Name of the state where the provider has their license.
    text? license_state? filters=trim
  
    // Expiration date of the license.
    date? license_expiry?
  
    // Malpractice Insurance of the provider.
    text? malpractice_insurance? filters=trim
  
    // Stripe account Id
    text? stripe_account_id? filters=trim
  
    // Designates whether the provider has finished the onboarding process.
    bool stripe_onboarding_complete
  
    enum status?=pending {
      values = ["pending", "active", "inactive"]
    }
  
    // The current step the provider is on in the onboarding process.
    int onboarding_step
  
    // The last time the provider logged in.
    timestamp? last_login_at?
  
    // User is a system admin.
    bool is_admin
  
    // Medical director path chosen in onboarding: melanite ($150/mo subscription) or own director. Null until chosen.
    enum? medical_director_type? {
      values = ["melanite", "own"]
    }
  
    // THE booking-gate field. melanite path: mirrors the Stripe subscription status. own path: active once director info + signed agreement are on file.
    enum medical_director_status?=none {
      values = ["none", "active", "past_due", "inactive"]
    }
  
    // The $150/mo Medical Director subscription (Melanite path). Indexed for webhook lookups.
    text? stripe_subscription_id? filters=trim
  
    // The provider's own Stripe Customer for billing the subscription (distinct from any client Customer).
    text? stripe_billing_customer_id? filters=trim
  
    // Own-director path: director full name.
    text? md_name? filters=trim
  
    // Own-director path: NPI number.
    text? md_npi? filters=trim
  
    // Own-director path: director medical license number.
    text? md_license_number? filters=trim
  
    // Own-director path: license state.
    text? md_license_state? filters=trim
  
    // Own-director path: license expiry.
    date? md_license_expiry?
  
    // Own-director path: credentials (MD/DO etc).
    text? md_credentials? filters=trim
  
    // Own-director path: director contact email.
    text? md_contact_email? filters=trim
  
    // Own-director path: director contact phone (E.164).
    text? md_contact_phone? filters=trim
  
    // Required training certificate uploaded during onboarding.
    uuid? training_cert_document_id? {
      table = "documents"
    }
  
    // Signed supervision agreement (own-director path only).
    uuid? md_agreement_document_id? {
      table = "documents"
    }
  
    // Notification pref: email when a client pays via the provider's checkout link.
    bool notify_booking_confirmed?=true
  
    // Notification pref: Stripe deposits a payout to the provider's bank.
    bool notify_payout_deposited?=true
  
    // Notification pref: 24-hour reminder before bookings.
    bool notify_appointment_reminders?=true
  
    // Notification pref: new laser availability opens on the calendar.
    bool notify_new_availability?=true
  
    // Notification pref: membership billing reminders and receipts.
    bool notify_membership_billing?=true
  
    // Manual booking gate. When false, provider cannot create bookings (frontend + server-side 403). Flipped true by admin once Keoni confirms required documents are on file. Separate from medical_director_status subscription gate.
    bool booking_enabled?
  
    timestamp? policy_ack_at?
    text? policy_ack_version? filters=trim
    enum role?="real_provider" {
      values = [
        "platform_owner"
        "developer"
        "medical_director"
        "real_provider"
        "test_provider"
      ]
    }
  
    bool room_rental_enabled?=true
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "email", op: "asc"}]}
    {type: "btree", field: [{name: "is_admin", op: "asc"}]}
    {type: "btree", field: [{name: "status", op: "asc"}]}
    {
      type : "btree"
      field: [{name: "stripe_account_id", op: "asc"}]
    }
    {
      type : "btree"
      field: [{name: "stripe_subscription_id", op: "asc"}]
    }
  ]
}