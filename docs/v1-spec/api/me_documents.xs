query "me/documents" verb=POST {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    file? content?
    text doc_type?
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    precondition ($input.doc_type == "training_certificate" || $input.doc_type == "supervision_agreement") {
      error_type = "badrequest"
      error = "INVALID_DOC_TYPE: doc_type must be training_certificate or supervision_agreement."
    }
  
    precondition ($input.content != null) {
      error_type = "badrequest"
      error = "NO_FILE: A file is required."
    }
  
    storage.create_attachment {
      value = $input.content
      access = "private"
    } as $file
  
    precondition ($file.mime == "application/pdf" || $file.mime == "image/jpeg" || $file.mime == "image/png") {
      error_type = "badrequest"
      error = "INVALID_MIME: Only PDF, JPG, or PNG files are allowed."
    }
  
    precondition ($file.size <= 10485760) {
      error_type = "badrequest"
      error = "FILE_TOO_LARGE: Files must be 10 MB or smaller."
    }
  
    db.add documents {
      enforce_hidden_fields = false
      data = {
        provider_id      : `$var.provider.id`
        doc_type         : `$input.doc_type`
        file             : `$var.file`
        original_filename: `$var.file.name`
        mime_type        : `$var.file.mime`
        size_bytes       : `$var.file.size`
      }
    } as $document
  
    conditional {
      if ($input.doc_type == "training_certificate") {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          enforce_hidden_fields = false
          data = {training_cert_document_id: `$var.document.id`}
        } as $prov_upd1
      }
    }
  
    conditional {
      if ($input.doc_type == "supervision_agreement") {
        db.edit providers {
          field_name = "id"
          field_value = `$var.provider.id`
          enforce_hidden_fields = false
          data = {md_agreement_document_id: `$var.document.id`}
        } as $prov_upd2
      }
    }
  }

  response = $document
}