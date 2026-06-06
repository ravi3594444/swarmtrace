"""
Utility functions for swarm trace monitoring and analysis.

This module provides helper functions for working with swarm agents,
token counting, and performance monitoring.
"""

import time
from typing import Any, Dict, Optional
from dataclasses import dataclass

@dataclass
class SwarmTraceRecord:
    """Data class for storing swarm agent trace information."""
    agent_id: str
    timestamp: float
    input_tokens: int
    output_tokens: int
    duration_ms: float
    status: str = "success"

    def to_dict(self) -> Dict[str, Any]:
        """Convert trace record to dictionary format."""
        return {
            'agent_id': self.agent_id,
            'timestamp': self.timestamp,
            'input_tokens': self.input_tokens,
            'output_tokens': self.output_tokens,
            'duration_ms': self.duration_ms,
            'status': self.status
        }

def time_execution(func, *args, **kwargs) -> tuple:
    """
