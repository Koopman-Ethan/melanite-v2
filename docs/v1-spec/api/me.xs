// Returns the authenticated provider record. Called on every app load to restore session and determine routing.
query me verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  }

  response = {provider: `$var.provider|unset:"password_hash"`}
}