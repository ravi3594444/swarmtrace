"""
Swarm Metrics Collector

This module collects and processes metrics from swarm trace data.
"""

import time
import json
import random
from typing import Dict, List, Any, Optional

class MetricsCollector:
    """Class for collecting and processing swarm metrics."""

    def __init__(self):
        """Initialize the metrics collector."""
        self.metrics = []
        self.sessions = {}

    def start_session(self, session_id: str) -> Dict[str, Any]:
        """
        Start a new metrics collection session.

        Args:
            session_id: Unique identifier for the session

        Returns:
            Dictionary containing session information
        """
        if session_id in self.sessions:
            raise ValueError(f"Session {session_id} already exists")

        self.sessions[session_id] = {
            'start_time': time.time(),
            'metrics': [],
            'active': True
        }

        return {
            'status': 'started',
            'session_id': session_id,
            'start_time': self.sessions[session_id]['start_time']
        }

    def end_session(self, session_id: str) -> Dict[str, Any]:
        """
        End a metrics collection session.

        Args:
            session_id: Unique identifier for the session

        Returns:
            Dictionary containing session summary
        """
        if session_id not in self.sessions:
            raise ValueError(f"Session {session_id} not found")

        if not self.sessions[session_id]['active']:
            raise ValueError(f"Session {session_id} already ended")

        self.sessions[session_id]['active'] = False
        self.sessions[session_id]['end_time'] = time.time()

        return {
            'status': 'ended',
            'session_id': session_id,
            'start_time': self.sessions[session_id]['start_time'],
            'end_time': self.sessions[session_id]['end_time'],
            'duration': self.sessions[session_id]['end_time'] - self.sessions[session_id]['start_time'],
            'metric_count': len(self.sessions[session_id]['metrics'])
        }

    def add_metric(self, session_id: str, metric_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Add a metric to a session.

        Args:
            session_id: Unique identifier for the session
            metric_data: Dictionary containing metric data

        Returns:
            Dictionary containing operation status
        """
        if session_id not in self.sessions:
            raise ValueError(f"Session {session_id} not found")

        if not self.sessions[session_id]['active']:
            raise ValueError(f"Session {session_id} is not active")

        metric_data['timestamp'] = time.time()
        self.sessions[session_id]['metrics'].append(metric_data)
        self.metrics.append(metric_data)

        return {
            'status': 'added',
            'session_id': session_id,
            'metric_index': len(self.sessions[session_id]['metrics']) - 1,
            'timestamp': metric_data['timestamp']
        }

    def get_session_metrics(self, session_id: str) -> List[Dict[str, Any]]:
        """
        Get all metrics for a session.

        Args:
            session_id: Unique identifier for the session

        Returns:
            List of metric dictionaries
        """
        if session_id not in self.sessions:
            raise ValueError(f"Session {session_id} not found")

        return self.sessions[session_id]['metrics'].copy()

    def get_all_metrics(self) -> List[Dict[str, Any]]:
        """
        Get all collected metrics.

        Returns:
            List of all metric dictionaries
        """
        return self.metrics.copy()

    def export_session(self, session_id: str, filepath: str) -> Dict[str, Any]:
        """
        Export a session's metrics to a JSON file.

        Args:
            session_id: Unique identifier for the session
            filepath: Path to save the JSON file

        Returns:
            Dictionary containing export status
        """
        if session_id not in self.sessions:
            raise ValueError(f"Session {session_id} not found")

        with open(filepath, 'w') as f:
            json.dump({
                'session_id': session_id,
                'start_time': self.sessions[session_id]['start_time'],
                'end_time': self.sessions[session_id].get('end_time'),
                'metric_count': len(self.sessions[session_id]['metrics']),
                'metrics': self.sessions[session_id]['metrics']
            }, f, indent=2)

        return {
            'status': 'exported',
            'session_id': session_id,
            'filepath': filepath,
            'metric_count': len(self.sessions[session_id]['metrics'])
        }

    def generate_session_report(self, session_id: str) -> Dict[str, Any]:
        """
        Generate a report for a session.

        Args:
            session_id: Unique identifier for the session

        Returns:
            Dictionary containing session report
        """
        if session_id not in self.sessions:
            raise ValueError(f"Session {session_id} not found")

        session = self.sessions[session_id]
        metrics = session['metrics']

        if not metrics:
            return {
                'status': 'no_data',
                'session_id': session_id,
                'message': 'No metrics collected in this session'
            }

        # Calculate basic statistics
        durations = []
        agent_counts = []

        for metric in metrics:
            if 'duration' in metric:
                durations.append(metric['duration'])
            if 'agent_count' in metric:
                agent_counts.append(metric['agent_count'])

        report = {
            'status': 'complete',
            'session_id': session_id,
            'start_time': session['start_time'],
            'end_time': session.get('end_time'),
            'metric_count': len(metrics),
            'first_metric_time': metrics[0]['timestamp'],
            'last_metric_time': metrics[-1]['timestamp'],
        }

        if durations:
            report['avg_duration'] = sum(durations) / len(durations)
            report['min_duration'] = min(durations)
            report['max_duration'] = max(durations)

        if agent_counts:
            report['avg_agent_count'] = sum(agent_counts) / len(agent_counts)
            report['min_agent_count'] = min(agent_counts)
            report['max_agent_count'] = max(agent_counts)

        return report

def generate_sample_metrics(session_id: str, count: int = 10):
    """
    Generate sample metrics for testing.

    Args:
        session_id: Unique identifier for the session
        count: Number of metrics to generate

    Returns:
        Tuple of (MetricsCollector, List[Dict]) so the caller can call
        collector.export_session() or collector.generate_session_report().
    """
    collector = MetricsCollector()
    collector.start_session(session_id)

    metrics = []
    for i in range(count):
        metric = {
            'iteration': i,
            'agent_count': random.randint(5, 20),
            'cluster_score': random.uniform(0.1, 1.0),
            'average_distance': random.uniform(1.0, 20.0),
            'duration': random.uniform(0.1, 1.0),
            'timestamp': time.time()
        }
        collector.add_metric(session_id, metric)
        metrics.append(metric)
        time.sleep(0.05)  # Small delay to simulate real collection

    collector.end_session(session_id)
    return collector, metrics

if __name__ == "__main__":
    print("Collecting sample swarm metrics...")

    # Create collector and start session
    collector = MetricsCollector()
    session_id = f"swarm_session_{int(time.time())}"
    collector.start_session(session_id)
    print(f"Started session: {session_id}")

    # Generate and add sample metrics
    sample_metrics = []
    for i in range(15):
        metric = {
            'iteration': i,
            'agent_count': random.randint(8, 18),
            'cluster_score': random.uniform(0.2, 0.9),
            'average_distance': random.uniform(2.0, 15.0),
            'duration': random.uniform(0.15, 0.85),
            'timestamp': time.time()
        }
        collector.add_metric(session_id, metric)
        sample_metrics.append(metric)
        print(f"Added metric {i+1}: {metric['agent_count']} agents, score: {metric['cluster_score']:.2f}")
        time.sleep(0.1)

    # End session and generate report
    collector.end_session(session_id)
    report = collector.generate_session_report(session_id)

    print("\nSession Report:")
    print(f"- Session ID: {report['session_id']}")
    print(f"- Metric count: {report['metric_count']}")
    print(f"- Duration: {report['last_metric_time'] - report['first_metric_time']:.2f} seconds")
    print(f"- Avg agents: {report.get('avg_agent_count', 0):.1f}")
    print(f"- Avg cluster score: {sum(m['cluster_score'] for m in sample_metrics)/len(sample_metrics):.2f}")

    # Export session
    export_path = f"swarm_metrics_{session_id}.json"
    collector.export_session(session_id, export_path)
    print(f"\nExported session metrics to {export_path}")