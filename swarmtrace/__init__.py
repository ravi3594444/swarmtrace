from swarmtrace.tracer import observe, init, session
from swarmtrace.storage import get_traces, save_trace
from swarmtrace.budget import budget, reset as reset_budget, get_usage
from swarmtrace.replay import show_failures
from swarmtrace.tool_attention import ToolAttention
from swarmtrace.pricing import set_model_pricing
from swarmtrace.auto_instrument import patch_all
from swarmtrace.fov import get_events
from swarmtrace import fov
from swarmtrace import alerts

__version__ = '0.5.0'
__all__ = [
    'observe', 'init', 'session',
    'get_traces', 'save_trace',
    'budget', 'reset_budget', 'get_usage',
    'show_failures',
    'ToolAttention',
    'set_model_pricing',
    'patch_all',
    'get_events',
    'fov',
    'alerts',
]
