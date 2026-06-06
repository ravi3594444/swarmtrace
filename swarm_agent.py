"""
Swarm Agent Implementation

Base classes for swarm agents tracked by the swarmtrace system.
"""

import math
import random
import time
from dataclasses import dataclass, field
from typing import List, Dict, Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WORLD_SIZE: float = 100.0   # agents are confined to [0, WORLD_SIZE] × [0, WORLD_SIZE]


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

@dataclass
class AgentState:
    agent_id: str
    swarm_id: str
    position: List[float] = field(default_factory=lambda: [
        random.uniform(0, WORLD_SIZE), random.uniform(0, WORLD_SIZE)
    ])
    velocity: float = field(default_factory=lambda: random.uniform(0.1, 2.0))
    neighbors: List["AgentState"] = field(default_factory=list, repr=False)

    def update_position(self) -> None:
        """Move the agent one step in a random direction, staying within bounds."""
        angle = random.uniform(0, 2 * math.pi)
        self.position[0] = max(0.0, min(WORLD_SIZE, self.position[0] + self.velocity * 0.1 * math.cos(angle)))
        self.position[1] = max(0.0, min(WORLD_SIZE, self.position[1] + self.velocity * 0.1 * math.sin(angle)))

    def find_neighbors(self, agents: List["AgentState"], radius: float = 10.0) -> None:
        self.neighbors = [
            a for a in agents
            if a.agent_id != self.agent_id and self._distance_to(a) <= radius
        ]

    def _distance_to(self, other: "AgentState") -> float:
        dx = self.position[0] - other.position[0]
        dy = self.position[1] - other.position[1]
        return math.hypot(dx, dy)

    def get_state(self) -> Dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "swarm_id": self.swarm_id,
            "position": tuple(self.position),
            "velocity": self.velocity,
            "neighbor_count": len(self.neighbors),
        }


# ---------------------------------------------------------------------------
# Swarm
# ---------------------------------------------------------------------------

class Swarm:
    """A collection of agents that move and sense each other."""

    def __init__(self, swarm_id: str, num_agents: int = 10) -> None:
        self.swarm_id = swarm_id
        self.agents: List[AgentState] = [
            AgentState(agent_id=f"{swarm_id}_agent_{i}", swarm_id=swarm_id)
            for i in range(num_agents)
        ]

    def step(self) -> None:
        """Advance all agents by one simulation step."""
        for agent in self.agents:
            agent.update_position()
        for agent in self.agents:
            agent.find_neighbors(self.agents)

    def update(self, iterations: int = 1) -> None:
        for _ in range(iterations):
            self.step()

    def get_swarm_state(self) -> Dict[str, Any]:
        return {
            "swarm_id": self.swarm_id,
            "agent_count": len(self.agents),
            "agent_states": [a.get_state() for a in self.agents],
        }


# ---------------------------------------------------------------------------
# Simulation helper
# ---------------------------------------------------------------------------

def simulate_swarm(
    swarm_id: str = "test_swarm",
    duration: int = 10,
    steps: int = 100,
) -> List[Dict[str, Any]]:
    """
    Simulate *swarm_id* for *duration* seconds at *steps* steps/second.

    Returns a list of per-step swarm states.
    """
    swarm = Swarm(swarm_id)
    states: List[Dict[str, Any]] = []
    step_delay = 1.0 / steps

    for _ in range(duration * steps):
        swarm.step()
        states.append(swarm.get_swarm_state())
        time.sleep(step_delay)

    return states


# ---------------------------------------------------------------------------
# Dev entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Starting swarm simulation...")
    results = simulate_swarm()
    print(f"Simulation complete. Final state has {len(results[-1]['agent_states'])} agents.")
