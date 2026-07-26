table documents {
  auth = false

  schema {
    uuid id
    uuid provider_id? {
      table = "providers"
    }
  
    enum? doc_type? {
      values = ["training_certificate", "supervision_agreement"]
    }
  
    attachment? file
    text? original_filename? filters=trim
    text? mime_type? filters=trim
    int? size_bytes?
    timestamp uploaded_at?=now
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "provider_id", op: "asc"}]}
    {
      type : "btree"
      field: [
        {name: "provider_id", op: "asc"}
        {name: "doc_type", op: "asc"}
      ]
    }
  ]
}