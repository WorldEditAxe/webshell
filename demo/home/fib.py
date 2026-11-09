#!/usr/bin/env python3
# apt install -y python3, then: python3 fib.py
import time
def fib(n): return n if n < 2 else fib(n - 1) + fib(n - 2)
t = time.time()
print(f"fib(25) = {fib(25)} in {time.time() - t:.2f} s, x86-64 Python on WebAssembly")
