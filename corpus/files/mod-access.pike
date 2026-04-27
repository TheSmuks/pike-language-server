// Corpus: mod-access.pike
// Exercises: protected, private, public, static visibility modifiers
// Priority: P0
// Errors: None expected (access violations are warnings/errors at call sites)
#pragma strict_types

class Visibility {
    // Public — accessible from anywhere (default)
    public string pub_name = "visible";

    // Protected — accessible in this class and inheriting classes
    protected string prot_data = "subclasses-only";

    // Private — accessible only in this class
    private string priv_secret = "hidden";

    // Static — class-level, not per-instance ( Pike synonym for protected in some contexts,
    //   but `static` on a variable means it's shared across instances )
    static int counter = 0;

    void create() {
        counter++;
    }

    string get_secret() {
        // Private members accessible within the class
        return priv_secret;
    }

    protected void prot_method() {
        // Protected method — callable from subclasses
    }
}

class SubVisibility {
    inherit Visibility;

    void test() {
        // pub_name — accessible (public)
        string n = pub_name;

        // prot_data — accessible (protected, we inherit)
        string d = prot_data;

        // priv_secret — NOT accessible directly; must use get_secret()
        string s = get_secret();

        // prot_method — accessible (protected)
        prot_method();
    }
}

int main() {
    Visibility v = Visibility();
    string name = v->pub_name;
    string secret = v->get_secret();

    SubVisibility sv = SubVisibility();
    sv->test();

    return 0;
}
