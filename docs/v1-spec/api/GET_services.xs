// List active platform services for onboarding Step 5 picker.
query services verb=GET {
  api_group = "melanite_v1"
  auth = "providers"

  input {
  }

  stack {
    function.run get_authenticated_provider {
      input = {auth_id: $auth.id}
    } as $provider
  
    db.query services {
      where = $db.services.active == true
      sort = {services.name: "asc"}
      return = {type: "list"}
    } as $services
  }

  response = {services: $services}
}