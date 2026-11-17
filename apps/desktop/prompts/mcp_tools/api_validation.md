## API validation

The app's test run covers the endpoints that have tests. Call an endpoint yourself only where a criterion's result isn't asserted by a test, or to reproduce a finding. Start the server with `mcp__vibe-teamlead__start_dev_server` and send requests to the URL it returns.

For each endpoint this task added or changed:

- it is registered and answers under the path the spec names;
- success returns the status and body shape the spec describes (201 for a created resource, not 200);
- invalid input is rejected with a 4xx and an error that says what is wrong, not accepted and not answered with a 200 or a 500;
- a protected route refuses a request without credentials (401) and one from a user who may not do this (403), and an unknown id gives 404.
