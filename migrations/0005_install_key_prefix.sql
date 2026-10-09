UPDATE memberships SET install_key = 'sgi_' || lower(hex(randomblob(32)));
