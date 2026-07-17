"""Delivery subsystem — gets recorded spans from process memory to the remote
ingest endpoint (and marks them synced once acknowledged).

The ``Sender`` owns the background worker thread, its bounded queue, the
batch-drain logic, retry/backoff, and fork-safe reset. It depends only on
a transport (``send_batch``) and a repository (``mark_synced``) plus a
config callable returning ``(api_key, url)`` — all injectable, so the
worker can be tested with fakes and a no-op sleep instead of real HTTP
and real time.
"""
