from setuptools import setup, find_packages
 
setup(
    name="swarmtrace",
    version="0.1.6",
    description="pytest for AI agents — trace, debug and catch regressions in LLM swarms",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    author="Ravi",
    packages=find_packages(),
    install_requires=["litai", "click", "rich"],
    entry_points={"console_scripts": [
        "swarmtrace=tracely.cli:view",
        "swarmtrace-export=tracely.export:main",
        "swarmtrace-replay=tracely.cli:main_replay"
    ]},
    python_requires=">=3.8",
)
 