class User:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return self._format()

    def _format(self):
        return f"hi {self.name}"
