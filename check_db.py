import sys
sys.path.insert(0, "/teamspace/studios/this_studio/tracely")
from tracely.storage import get_traces

traces = get_traces()
for t in traces:
    print(t)
