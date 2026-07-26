query "me/documents/{document_id}" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
    text document_id filters=trim
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.get documents {
      field_name = "id"
      field_value = `$input.document_id`
    } as $doc
  
    precondition ($doc != null) {
      error_type = "notfound"
      error = "DOCUMENT_NOT_FOUND: That document does not exist."
    }
  
    precondition ($doc.provider_id == $provider.id) {
      error_type = "accessdenied"
      error = "ACCESS_DENIED: You do not have access to that document."
    }
  }

  response = {document: `$var.doc`}
}