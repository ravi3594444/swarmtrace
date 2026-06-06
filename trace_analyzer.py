"""
Swarm Trace Analyzer

This module provides tools for analyzing swarm trace data.
"""

import json
import time
import random
from typing import List, Dict, Any, Optional

class TraceAnalyzer:
    """Class for analyzing swarm trace data."""

    def __init__(self):
        """Initialize the trace analyzer."""
        self.traces = []
        self.analysis_results = []

    def add_trace(self, trace_data: Dict[str, Any]):
        """
        Add trace data to the analyzer.

        Args:
            trace_data: Dictionary containing trace information
        """
        self.traces.append({
            'timestamp': time.time(),
            'data': trace_data
        })

    def analyze_traces(self) -> List[Dict[str, Any]]:
        """
        Analyze all collected traces.

        Returns:
            List of analysis results
        """
        self.analysis_results = []

        for i, trace in enumerate(self.traces):
            result = {
                'trace_index': i,
                'timestamp': trace['timestamp'],
                'agent_count': len(trace['data'].get('agents', [])),
                'metrics': self._calculate_metrics(trace['data'])
            }
            self.analysis_results.append(result)

        return self.analysis_results

    def _calculate_metrics(self, trace_data: Dict[str, Any]) -> Dict[str, float]:
        """
        Calculate metrics from trace data.

        Args:
            trace_data: Dictionary containing trace data

        Returns:
            Dictionary of calculated metrics
        """
        agents = trace_data.get('agents', [])
        if not agents:
            return {
                'average_distance': 0,
                'max_distance': 0,
                'cluster_score': 0
            }

        # Calculate pairwise distances
        distances = []
        for i in range(len(agents)):
            for j in range(i+1, len(agents)):
                dx = agents[i]['x'] - agents[j]['x']
                dy = agents[i]['y'] - agents[j]['y']
                distance = (dx**2 + dy**2)**0.5
                distances.append(distance)

        if not distances:
            return {
                'average_distance': 0,
                'max_distance': 0,
                'cluster_score': 0
            }

        avg_distance = sum(distances) / len(distances)
        max_distance = max(distances)

        # Simple cluster score (inverse of average distance)
        cluster_score = 1.0 / (avg_distance + 0.1)  # Avoid division by zero

        return {
            'average_distance': avg_distance,
            'max_distance': max_distance,
            'cluster_score': cluster_score
        }

    def export_analysis(self, filepath: str):
        """
        Export analysis results to a JSON file.

        Args:
            filepath: Path to save the JSON file
        """
        with open(filepath, 'w') as f:
            json.dump({
                'analysis_timestamp': time.time(),
                'trace_count': len(self.traces),
                'results': self.analysis_results
            }, f, indent=2)

    def generate_report(self) -> Dict[str, Any]:
        """
        Generate a summary report of the analysis.

        Returns:
            Dictionary containing summary statistics
        """
        if not self.analysis_results:
            return {
                'status': 'no_data',
                'message': 'No traces have been analyzed yet'
            }

        agent_counts = [r['agent_count'] for r in self.analysis_results]
        cluster_scores = [r['metrics']['cluster_score'] for r in self.analysis_results]

        return {
            'status': 'complete',
            'trace_count': len(self.analysis_results),
            'average_agent_count': sum(agent_counts) / len(agent_counts),
            'min_cluster_score': min(cluster_scores) if cluster_scores else 0,
            'max_cluster_score': max(cluster_scores) if cluster_scores else 0,
            'average_cluster_score': sum(cluster_scores) / len(cluster_scores) if cluster_scores else 0,
            'start_time': min(r['timestamp'] for r in self.analysis_results),
            'end_time': max(r['timestamp'] for r in self.analysis_results)
        }

def generate_sample_traces(count: int = 10) -> List[Dict[str, Any]]:
    """
    Generate sample trace data for testing.

    Args:
        count: Number of trace samples to generate

    Returns:
        List of trace dictionaries
    """
    traces = []
    for i in range(count):
        agents = []
        for j in range(random.randint(5, 15)):
            agents.append({
                'id': f'agent_{j}',
                'x': random.uniform(0, 100),
                'y': random.uniform(0, 100)
            })

        traces.append({
            'iteration': i,
            'timestamp': time.time(),
            'agents': agents
        })

        time.sleep(0.05)  # Small delay to simulate real-time data

    return traces

if __name__ == "__main__":
    print("Generating sample traces and analyzing...")
    analyzer = TraceAnalyzer()

    # Generate and add sample traces
    sample_traces = generate_sample_traces(15)
    for trace in sample_traces:
        analyzer.add_trace(trace)

    # Analyze the traces
    results = analyzer.analyze_traces()
    print(f"Analyzed {len(results)} traces")

    # Generate and print report
    report = analyzer.generate_report()
    print("\nAnalysis Report:")
    print(f"- Status: {report['status']}")
    print(f"- Trace count: {report['trace_count']}")
    print(f"- Average agent count: {report['average_agent_count']:.1f}")
    print(f"- Cluster score range: {report['min_cluster_score']:.2f} to {report['max_cluster_score']:.2f}")
    print(f"- Average cluster score: {report['average_cluster_score']:.2f}")

    # Export analysis
    export_path = "swarm_trace_analysis.json"
    analyzer.export_analysis(export_path)
    print(f"\nExported analysis to {export_path}")