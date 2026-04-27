// Exercises: Named inherit, scoped access via inherit Foo : alias
#pragma strict_types

class Logger {
  void log(string msg) {
    write("[LOG] %s\n", msg);
  }
}

class Service {
  inherit Logger : log;

  void run() {
    log::log("Service started");
    log::log("Service running");
    log::log("Service stopped");
  }
}

int main() {
  Service s = Service();
  s->run();
  return 0;
}
