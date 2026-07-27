query "me/documents" verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.query documents {
      where = $db.documents.provider_id == `$var.provider.id`
      return = {type: "list"}
    } as $docs
  }

  response = {documents: `$var.docs`}
}