"""I/O adapters for the SwarmTrace runtime.

Adapters turn the core ``SpanRecord`` / port contracts into concrete
storage and transport implementations. Nothing in the core imports a
specific adapter by name in its public surface — adapters are wired up
by the runtime (``swarmtrace.runtime``) and by ``tracer.py``.
"""
