# Hosted study contract

The portal, JATOS, and Pavlovia builds share one experiment protocol and one
Study API. Host adapters may provide lifecycle callbacks and technical session
metadata, but they may not determine schedules, outcomes, counterbalancing, or
completion validity.

The API is authoritative for participant authentication, server-side outcome
resolution, event sequence numbers, completion, and research exports.
