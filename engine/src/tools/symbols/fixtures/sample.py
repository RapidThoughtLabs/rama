class Animal:
    def __init__(self, name: str) -> None:
        self.name = name

    async def speak(self) -> str:
        return f"{self.name} speaks"


def helper(x: int) -> int:
    return x * 2
