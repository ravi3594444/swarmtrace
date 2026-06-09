"""
Swarm Module — Trace Simulation

Parameterised swarm simulator. Replaces the five identical swarm_module_*.py files.
Usage:
    from swarm_module import SwarmTraceSimulator
    sim = SwarmTraceSimulator(index=2)
"""

import time
import random


class SwarmTraceSimulator:
    """Parameterised swarm trace simulator."""

    def __init__(self, index: int = 0):
        self.index = index
        self.agents = [
            {'id': j, 'x': random.random() * 100, 'y': random.random() * 100}
            for j in range(10)
        ]
        self.iteration = 0

    def update(self):
        """Update swarm positions."""
        for agent in self.agents:
            agent['x'] += (random.random() - 0.5) * 2
            agent['y'] += (random.random() - 0.5) * 2
        self.iteration += 1

    def get_trace(self):
        """Return current trace snapshot."""
        return {
            'index': self.index,
            'iteration': self.iteration,
            'agents': self.agents.copy(),
        }


if __name__ == "__main__":
    import sys
    idx = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    simulator = SwarmTraceSimulator(index=idx)
    for _ in range(10):
        simulator.update()
        trace = simulator.get_trace()
        print(f"Module {trace['index']} - Iteration {trace['iteration']}: {len(trace['agents'])} agents")
        time.sleep(0.1)
